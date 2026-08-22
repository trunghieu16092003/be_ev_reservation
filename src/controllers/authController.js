const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const prisma = require('../config/prisma')
const redis = require('../config/redis')
const jwt = require('jsonwebtoken');
const AppError = require('../utils/AppError')
const { verifyGoogleToken } = require('../services/googleAuthService');


const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 ngày, khớp REFRESH_TOKEN_EXPIRE trong .env
const OTP_TTL_SECONDS = 5 * 60; // OTP sống 5 phút
const MAX_OTP_ATTEMPTS = 5; // nhập sai quá 5 lần -> bắt đăng ký lại (chống brute-force 6 số)

function otpKey(phone) {
    return `otp:register:${phone}`;
}

function otpAttemptsKey(phone) {
    return `otp:attempts:${phone}`;
}

function sanitizeUser(user) {
    const { passwordHash, ...userWithoutPassword } = user;
    return userWithoutPassword
}


const registerCustomer = async (req, res, next) => {
    const { phone, pin, fullName } = req.body;
    const userExists = await prisma.user.findUnique({ where: { phone } });
    if (userExists) {
        return next(new AppError('Số điện thoại đã được sử dụng', 400))
    }

    const passwordHash = await bcrypt.hash(pin, 12);
    const otp = crypto.randomInt(100000, 999999).toString();
    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');

    // Chưa tạo User thật - lưu tạm vào Redis, chỉ tạo User khi verify-otp đúng
    await redis.set(
        otpKey(phone),
        JSON.stringify({ passwordHash, fullName: fullName ?? null, otpHash }),
        'EX',
        OTP_TTL_SECONDS
    );
    await redis.del(otpAttemptsKey(phone));

    // TODO: thay bằng gửi SMS thật khi chọn được nhà cung cấp (eSMS/SpeedSMS/Twilio...)
    console.log(`[OTP] Gửi mã ${otp} tới số ${phone} (hết hạn sau ${OTP_TTL_SECONDS / 60} phút)`);

    res.json({ data: { message: 'Đã gửi mã OTP, vui lòng xác thực trong 5 phút', phone } });
}

const verifyOtp = async (req, res, next) => {
    const { phone, otp } = req.body;

    const raw = await redis.get(otpKey(phone));
    if (!raw) {
        return next(new AppError('Mã OTP không tồn tại hoặc đã hết hạn, vui lòng đăng ký lại', 400));
    }

    const attempts = Number(await redis.get(otpAttemptsKey(phone))) || 0;
    if (attempts >= MAX_OTP_ATTEMPTS) {
        await redis.del(otpKey(phone), otpAttemptsKey(phone));
        return next(new AppError('Nhập sai quá nhiều lần, vui lòng đăng ký lại', 400));
    }

    const pending = JSON.parse(raw);
    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');

    if (otpHash !== pending.otpHash) {
        await redis.multi().incr(otpAttemptsKey(phone)).expire(otpAttemptsKey(phone), OTP_TTL_SECONDS).exec();
        return next(new AppError('Mã OTP không đúng', 400));
    }

    const user = await prisma.user.create({
        data: {
            phone,
            passwordHash: pending.passwordHash,
            fullName: pending.fullName,
            role: 'customer',
        },
    });

    await redis.del(otpKey(phone), otpAttemptsKey(phone));

    const { accessToken, refreshToken } = await issueTokens(user, req);
    res.status(201).json({ data: { accessToken, refreshToken, user: sanitizeUser(user) } });
}

const registerOwner = async (req, res, next) => {
    const { email, password, fullName, phone } = req.body;
    const userExists = await prisma.user.findUnique({ where: { email } });
    if (userExists) {
        return next(new AppError('Email đã được sử dụng', 400))
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
        data: { email, passwordHash, fullName, phone, role: 'station_owner' },
    })

    res.status(201).json({ data: sanitizeUser(user) });
}

async function issueTokens(user, req) {
    const accessToken = jwt.sign(
        { id: user.id, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRE }
    );

    const refreshToken = crypto.randomBytes(40).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

    await prisma.refreshToken.create({
        data: {
            userId: user.id,
            tokenHash,
            deviceInfo: req.headers['user-agent'] ?? null,
            expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        },
    });

    return { accessToken, refreshToken };
}

const loginCustomer = async (req, res, next) => {
    const { phone, pin } = req.body;
    const user = await prisma.user.findUnique({ where: { phone } });

    if (!user || !user.passwordHash) {
        return next(new AppError('Sai số điện thoại hoặc mã PIN', 401));
    }

    const isValid = await bcrypt.compare(pin, user.passwordHash);
    if (!isValid) {
        return next(new AppError('Sai số điện thoại hoặc mã PIN', 401));
    }

    const { accessToken, refreshToken } = await issueTokens(user, req);
    res.json({ data: { accessToken, refreshToken, user: sanitizeUser(user) } });
}

const loginOwner = async (req, res, next) => {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !user.passwordHash) {
        return next(new AppError('Sai email hoặc mật khẩu', 401));
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
        return next(new AppError('Sai email hoặc mật khẩu', 401));
    }

    const { accessToken, refreshToken } = await issueTokens(user, req);
    res.json({ data: { accessToken, refreshToken, user: sanitizeUser(user) } });
}

//----LOGIN GOOGLE----
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
                role
            }
        })
    }
    return user;
}

function loginGoogleHandler(role) {
    return async (req, res, next) => {
        const { idToken } = req.body;
        let payload;
        try {
            payload = await verifyGoogleToken(idToken);
        } catch (err) {
            return next(new AppError('Token Google không hợp lệ', 401));
        }

        const user = await findOrCreateGoogleUser(payload, role);
        const { accessToken, refreshToken } = await issueTokens(user, req);
        res.json({ data: { accessToken, refreshToken, user: sanitizeUser(user) } });
    };
}

const loginGoogleCustomer = loginGoogleHandler('customer');
const loginGoogleOwner = loginGoogleHandler('station_owner');


const refreshTokenHandler = async (req, res, next) => {
    const { refreshToken } = req.body
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

    const record = await prisma.refreshToken.findUnique({ where: { tokenHash } })

    if (!record) {
        return next(new AppError('Refresh Token không hợp lệ', 401));

    }

    if (record.revokedAt) {
        await prisma.refreshToken.updateMany({
            where: { userId: record.userId, revokedAt: null },
            data: { revokedAt: new Date(), }
        })
        return next(new AppError('Refresh Token đã bị thu hồi', 401));
    }

    if (record.expiresAt < new Date()) {
        return next(new AppError('Refresh token đã hết hạn', 401));
    }

    const user = await prisma.user.findUnique({ where: { id: record.userId } })
    const accessToken = jwt.sign(
        { id: user.id, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRE }
    );

    // --- Rotate: revoke token cũ, cấp token mới, trong cùng 1 transaction ---
    const newRefreshToken = crypto.randomBytes(40).toString('hex');
    const newTokenHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');

    await prisma.$transaction([
        prisma.refreshToken.update({
            where: { id: record.id },
            data: { revokedAt: new Date() },
        }),
        prisma.refreshToken.create({
            data: {
                userId: record.userId,
                tokenHash: newTokenHash,
                deviceInfo: record.deviceInfo,
                expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
            },
        }),
    ]);

    res.json({ data: { accessToken, refreshToken: newRefreshToken } });
}

const logout = async (req, res, next) => {
    const { refreshToken } = req.body;
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

    await prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
    });

    res.json({ data: { message: 'Đăng xuất thành công' } });
};


module.exports = {
    registerCustomer,
    verifyOtp,
    registerOwner,
    loginCustomer,
    loginOwner,
    loginGoogleCustomer,
    loginGoogleOwner,
    refreshToken: refreshTokenHandler,
    logout,
};