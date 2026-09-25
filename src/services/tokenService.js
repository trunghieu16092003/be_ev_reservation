const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const prisma = require('../config/prisma');

const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 ngày, khớp REFRESH_TOKEN_EXPIRE trong .env

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function signAccessToken(user) {
    return jwt.sign(
        { id: user.id, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRE }
    );
}

async function issueTokens(user, req) {
    const accessToken = signAccessToken(user);
    const refreshToken = crypto.randomBytes(40).toString('hex');

    await prisma.refreshToken.create({
        data: {
            userId: user.id,
            tokenHash: hashToken(refreshToken),
            deviceInfo: req.headers['user-agent'] ?? null,
            expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        },
    });

    return { accessToken, refreshToken };
}

// Rotate: revoke refresh token cũ, cấp cặp access+refresh token mới, trong cùng 1 transaction
async function rotateRefreshToken(record, user) {
    const accessToken = signAccessToken(user);
    const refreshToken = crypto.randomBytes(40).toString('hex');

    await prisma.$transaction([
        prisma.refreshToken.update({
            where: { id: record.id },
            data: { revokedAt: new Date() },
        }),
        prisma.refreshToken.create({
            data: {
                userId: record.userId,
                tokenHash: hashToken(refreshToken),
                deviceInfo: record.deviceInfo,
                expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
            },
        }),
    ]);

    return { accessToken, refreshToken };
}

async function revokeAllUserTokens(userId) {
    await prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
    });
}

module.exports = {
    hashToken,
    issueTokens,
    rotateRefreshToken,
    revokeAllUserTokens,
};
