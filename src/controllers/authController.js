const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const prisma = require('../config/prisma')
const redis = require('../config/redis')
const jwt = require('jsonwebtoken');
const AppError = require('../utils/AppError')
const { verifyGoogleToken } = require('../services/googleAuthService');
const { verifyFacebookToken } = require('../services/facebookAuthService');
const { UserRole } = require('../generated/prisma');

const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 ngày, khớp REFRESH_TOKEN_EXPIRE trong .env
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
    return `otp:reset:${identifier}`
}

function resetOtpAttemptsKey(identifier) {
    return `otp:reset:attempts:${identifier}`
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
            role: UserRole.customer,
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
        data: { email, passwordHash, fullName, phone, role: UserRole.station_owner },
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

const loginGoogleCustomer = loginGoogleHandler(UserRole.customer);
const loginGoogleOwner = loginGoogleHandler(UserRole.station_owner);


//---LOGIC FACEBOOK---
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
                role
            }
        });
    }
    return user;
}

// Factory: chạy 1 lần lúc load file để "đúc" ra 1 handler đã khoá sẵn `role` qua closure.
// Cần vậy vì Express luôn gọi handler với đúng 3 tham số (req, res, next), không có
// chỗ nào để truyền thêm `role` vào lúc gọi - nên phải nhét `role` vào TRƯỚC, ở đây.
function loginFacebookHandler(role) {
    return async (req, res, next) => {
        const { accessToken: fbAccessToken } = req.body;
        let payload;
        try {
            payload = await verifyFacebookToken(fbAccessToken);
        } catch (err) {
            return next(new AppError('Token Facebook không hợp lệ', 401));
        }

        const user = await findOrCreateFacebookUser(payload, role);
        const { accessToken, refreshToken } = await issueTokens(user, req);
        res.json({ data: { accessToken, refreshToken, user: sanitizeUser(user) } });
    };
}

const loginFacebookCustomer = loginFacebookHandler(UserRole.customer);
const loginFacebookOwner = loginFacebookHandler(UserRole.station_owner);

// ---FORGOT PASSWORD---
function forgotPasswordHandler({ role, identifierField, channelLabel }) {
    return async (req, res, next) => {
        const identifier = req.body[identifierField];
        const user = await prisma.user.findUnique({ where: { [identifierField]: identifier } });

        // không tiết lộ identifier có tồn tại hay không -> generic response
        const genericMessage = `Nếu ${channelLabel} tồn tại, mã OTP đã được gửi`;

        if (!user || user.role !== role) {
            return res.json({ data: { message: genericMessage } });
        }

        const otp = crypto.randomInt(100000, 999999).toString();
        const otpHash = crypto.createHash('sha256').update(otp).digest('hex');

        await redis.set(resetOtpKey(identifier), otpHash, 'EX', RESET_OTP_TTL_SECONDS);
        // dùng để xóa bộ đếm số lần nhập otp sai khi có otp mới
        await redis.del(resetOtpAttemptsKey(identifier));

        // TODO: thay bằng gửi SMS/email thật khi chọn được nhà cung cấp
        console.log(`[OTP] Gửi mã đặt lại mật khẩu ${otp} tới ${channelLabel} ${identifier} (hết hạn sau ${RESET_OTP_TTL_SECONDS / 60} phút)`);

        res.json({ data: { message: genericMessage } });
    };
}

const forgotPasswordCustomer = forgotPasswordHandler({ role: UserRole.customer, identifierField: 'phone', channelLabel: 'số điện thoại' });
const forgotPasswordOwner = forgotPasswordHandler({ role: UserRole.station_owner, identifierField: 'email', channelLabel: 'email' });

//---RESET PASSWORD---

function resetPasswordHandler({ role, identifierField, credentialField }) {
    return async (req, res, next) => {
        const identifier = req.body[identifierField];
        const { otp } = req.body;
        const newCredential = req.body[credentialField];

        const otpHash = await redis.get(resetOtpKey(identifier));
        if (!otpHash) {
            return next(new AppError('Mã OTP không tồn tại hoặc đã hết hạn, vui lòng yêu cầu lại', 400));
        }

        const attempts = Number(await redis.get(resetOtpAttemptsKey(identifier))) || 0;
        if (attempts >= MAX_RESET_OTP_ATTEMPTS) {
            await redis.del(resetOtpKey(identifier), resetOtpAttemptsKey(identifier));
            return next(new AppError('Nhập sai quá nhiều lần, vui lòng yêu cầu lại', 400));
        }

        const inputHash = crypto.createHash('sha256').update(otp).digest('hex');
        if (inputHash !== otpHash) {
            await redis.multi().incr(resetOtpAttemptsKey(identifier)).expire(resetOtpAttemptsKey(identifier), RESET_OTP_TTL_SECONDS).exec();
            return next(new AppError('Mã OTP không đúng', 400));
        }

        const user = await prisma.user.findUnique({ where: { [identifierField]: identifier } });
        if (!user || user.role !== role) {
            return next(new AppError('Không tìm thấy tài khoản', 400));
        }

        const passwordHash = await bcrypt.hash(newCredential, 12);
        await prisma.$transaction([
            prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
            prisma.refreshToken.updateMany({
                where: { userId: user.id, revokedAt: null },
                data: { revokedAt: new Date() }
            }),
        ]);

        await redis.del(resetOtpKey(identifier), resetOtpAttemptsKey(identifier));
        res.json({ data: { message: 'Đặt lại mật khẩu thành công, vui lòng đăng nhập lại' } });
    };
}

const resetPasswordCustomer = resetPasswordHandler({ role: UserRole.customer, identifierField: 'phone', credentialField: 'newPin' });
const resetPasswordOwner = resetPasswordHandler({ role: UserRole.station_owner, identifierField: 'email', credentialField: 'newPassword' });


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
    loginFacebookCustomer,
    loginFacebookOwner,
    forgotPasswordCustomer,
    forgotPasswordOwner,
    resetPasswordCustomer,
    resetPasswordOwner,
    refreshToken: refreshTokenHandler,
    logout,
};