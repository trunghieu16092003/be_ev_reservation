const AppError = require('../utils/AppError');
const prisma = require('../config/prisma');
const redis = require('../config/redis');
const { verifyGoogleToken } = require('../services/googleAuthService');
const { verifyFacebookToken } = require('../services/facebookAuthService');
const { UserRole } = require('../generated/prisma');
const {
    hashToken,
    issueTokens,
    rotateRefreshToken,
    revokeAllUserTokens,
} = require('../services/tokenService');
const {
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
} = require('../services/authService');

const registerCustomer = async (req, res, next) => {
    const { phone, pin, fullName } = req.body;
    const userExists = await prisma.user.findUnique({ where: { phone } });
    if (userExists) {
        return next(new AppError('Số điện thoại đã được sử dụng', 400));
    }

    const passwordHash = await hashCredential(pin);
    const { otp, otpHash } = generateOtp();

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
};

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
    const otpHash = hashOtp(otp);

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
};

const registerOwner = async (req, res, next) => {
    const { email, password, fullName, phone } = req.body;
    const userExists = await prisma.user.findUnique({ where: { email } });
    if (userExists) {
        return next(new AppError('Email đã được sử dụng', 400));
    }

    const passwordHash = await hashCredential(password);
    const user = await prisma.user.create({
        data: { email, passwordHash, fullName, phone, role: UserRole.station_owner },
    });

    res.status(201).json({ data: sanitizeUser(user) });
};

const loginCustomer = async (req, res, next) => {
    const { phone, pin } = req.body;
    const user = await prisma.user.findUnique({ where: { phone } });

    if (!user || !user.passwordHash) {
        return next(new AppError('Sai số điện thoại hoặc mã PIN', 401));
    }

    const isValid = await verifyCredential(pin, user.passwordHash);
    if (!isValid) {
        return next(new AppError('Sai số điện thoại hoặc mã PIN', 401));
    }

    const { accessToken, refreshToken } = await issueTokens(user, req);
    res.json({ data: { accessToken, refreshToken, user: sanitizeUser(user) } });
};

const loginOwner = async (req, res, next) => {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !user.passwordHash) {
        return next(new AppError('Sai email hoặc mật khẩu', 401));
    }

    const isValid = await verifyCredential(password, user.passwordHash);
    if (!isValid) {
        return next(new AppError('Sai email hoặc mật khẩu', 401));
    }

    const { accessToken, refreshToken } = await issueTokens(user, req);
    res.json({ data: { accessToken, refreshToken, user: sanitizeUser(user) } });
};

//----LOGIN GOOGLE----
// Factory: chạy 1 lần lúc load file để "đúc" ra 1 handler đã khoá sẵn `role` qua closure.
// Cần vậy vì Express luôn gọi handler với đúng 3 tham số (req, res, next), không có
// chỗ nào để truyền thêm `role` vào lúc gọi - nên phải nhét `role` vào TRƯỚC, ở đây.
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

        const { otp, otpHash } = generateOtp();

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

        const inputHash = hashOtp(otp);
        if (inputHash !== otpHash) {
            await redis.multi().incr(resetOtpAttemptsKey(identifier)).expire(resetOtpAttemptsKey(identifier), RESET_OTP_TTL_SECONDS).exec();
            return next(new AppError('Mã OTP không đúng', 400));
        }

        const user = await prisma.user.findUnique({ where: { [identifierField]: identifier } });
        if (!user || user.role !== role) {
            return next(new AppError('Không tìm thấy tài khoản', 400));
        }

        const passwordHash = await hashCredential(newCredential);
        await updatePasswordAndRevokeSessions(user.id, passwordHash);

        await redis.del(resetOtpKey(identifier), resetOtpAttemptsKey(identifier));
        res.json({ data: { message: 'Đặt lại mật khẩu thành công, vui lòng đăng nhập lại' } });
    };
}

const resetPasswordCustomer = resetPasswordHandler({ role: UserRole.customer, identifierField: 'phone', credentialField: 'newPin' });
const resetPasswordOwner = resetPasswordHandler({ role: UserRole.station_owner, identifierField: 'email', credentialField: 'newPassword' });

//---CHANGE PASSWORD---
function changePasswordHandler({ role, currentField, newField }) {
    return async (req, res, next) => {
        const userId = req.user.id;
        const currentPassword = req.body[currentField];
        const newPassword = req.body[newField];
        const { refreshToken } = req.body;
        const tokenHash = hashToken(refreshToken);

        const user = await prisma.user.findUnique({ where: { id: userId } });

        if (!user || user.role !== role) {
            return next(new AppError('Không tìm thấy tài khoản', 400));
        }

        const isValid = await verifyCredential(currentPassword, user.passwordHash);
        if (!isValid) {
            return next(new AppError('Sai mật khẩu hiện tại', 401));
        }

        const currentSession = await prisma.refreshToken.findUnique({ where: { tokenHash } });
        if (!currentSession || currentSession.userId !== userId || currentSession.revokedAt) {
            return next(new AppError('Refresh token không hợp lệ', 401));
        }

        const newPasswordHash = await hashCredential(newPassword);
        await updatePasswordAndRevokeSessions(userId, newPasswordHash, tokenHash);

        res.json({ data: { message: 'Đổi mật khẩu thành công' } });
    };
}

const changePasswordCustomer = changePasswordHandler({ role: UserRole.customer, currentField: 'currentPin', newField: 'newPin' });
const changePasswordOwner = changePasswordHandler({ role: UserRole.station_owner, currentField: 'currentPassword', newField: 'newPassword' });

const refreshTokenHandler = async (req, res, next) => {
    const { refreshToken } = req.body;
    const tokenHash = hashToken(refreshToken);

    const record = await prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!record) {
        return next(new AppError('Refresh Token không hợp lệ', 401));
    }

    if (record.revokedAt) {
        await revokeAllUserTokens(record.userId);
        return next(new AppError('Refresh Token đã bị thu hồi', 401));
    }

    if (record.expiresAt < new Date()) {
        return next(new AppError('Refresh token đã hết hạn', 401));
    }

    const user = await prisma.user.findUnique({ where: { id: record.userId } });
    const { accessToken, refreshToken: newRefreshToken } = await rotateRefreshToken(record, user);

    res.json({ data: { accessToken, refreshToken: newRefreshToken } });
};

const logout = async (req, res, next) => {
    const { refreshToken } = req.body;
    const tokenHash = hashToken(refreshToken);

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
    changePasswordCustomer,
    changePasswordOwner,
    refreshToken: refreshTokenHandler,
    logout,
};
