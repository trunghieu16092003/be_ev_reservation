const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');

const PASSWORD_HASH_COST = 12;
const OTP_TTL_SECONDS = 5 * 60; // OTP sống 5 phút
const MAX_OTP_ATTEMPTS = 5; // nhập sai quá 5 lần -> bắt đăng ký lại (chống brute-force 6 số)
const RESET_OTP_TTL_SECONDS = 5 * 60;
const MAX_RESET_OTP_ATTEMPTS = 5;

function otpKey(phone) {
    return `otp:register:${phone}`;
}

function otpAttemptsKey(phone) {
    return `otp:attempts:${phone}`;
}

function resetOtpKey(identifier) {
    return `otp:reset:${identifier}`;
}

function resetOtpAttemptsKey(identifier) {
    return `otp:reset:attempts:${identifier}`;
}

function sanitizeUser(user) {
    const { passwordHash, ...userWithoutPassword } = user;
    return userWithoutPassword;
}

async function hashCredential(plain) {
    return bcrypt.hash(plain, PASSWORD_HASH_COST);
}

async function verifyCredential(plain, hash) {
    return bcrypt.compare(plain, hash);
}

function hashOtp(otp) {
    return crypto.createHash('sha256').update(otp).digest('hex');
}

function generateOtp() {
    const otp = crypto.randomInt(100000, 999999).toString();
    return { otp, otpHash: hashOtp(otp) };
}

async function findOrCreateGoogleUser(payload, role) {
    if (!payload.email_verified) {
        throw new AppError('Email Google chưa được xác thực', 400);
    }

    let user = await prisma.user.findUnique({ where: { email: payload.email } });

    if (!user) {
        user = await prisma.user.create({
            data: {
                email: payload.email,
                fullName: payload.name,
                avatarUrl: payload.picture,
                role,
            },
        });
    }
    return user;
}

async function findOrCreateFacebookUser(payload, role) {
    if (!payload.email) {
        throw new AppError('Tài khoản Facebook của bạn chưa cấp quyền email, không thể đăng nhập', 400);
    }
    let user = await prisma.user.findUnique({ where: { email: payload.email } });
    if (!user) {
        user = await prisma.user.create({
            data: {
                email: payload.email,
                fullName: payload.name,
                role,
            },
        });
    }
    return user;
}

// Đổi mật khẩu + thu hồi refresh token đang sống trong cùng 1 transaction (atomic) -
// dùng chung cho cả forgot/reset-password (exceptTokenHash = null, revoke hết) và
// change-password (exceptTokenHash = token của phiên hiện tại, chừa lại phiên đó).
async function updatePasswordAndRevokeSessions(userId, newPasswordHash, exceptTokenHash = null) {
    await prisma.$transaction([
        prisma.user.update({ where: { id: userId }, data: { passwordHash: newPasswordHash } }),
        prisma.refreshToken.updateMany({
            where: {
                userId,
                revokedAt: null,
                ...(exceptTokenHash ? { tokenHash: { not: exceptTokenHash } } : {}),
            },
            data: { revokedAt: new Date() },
        }),
    ]);
}

module.exports = {
    OTP_TTL_SECONDS,
    MAX_OTP_ATTEMPTS,
    RESET_OTP_TTL_SECONDS,
    MAX_RESET_OTP_ATTEMPTS,
    otpKey,
    otpAttemptsKey,
    resetOtpKey,
    resetOtpAttemptsKey,
    sanitizeUser,
    hashCredential,
    verifyCredential,
    hashOtp,
    generateOtp,
    findOrCreateGoogleUser,
    findOrCreateFacebookUser,
    updatePasswordAndRevokeSessions,
};
