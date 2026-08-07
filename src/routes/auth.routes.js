const express = require('express');
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const validate = require('../middleware/validate');
const authController = require('../controllers/authController');

const router = express.Router();

// Đăng ký/đăng nhập station_owner (email+password) không dễ đoán bằng PIN 6 số,
// nhưng vẫn giới hạn để chống brute-force chung
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Thử lại quá nhiều lần, vui lòng đợi ít phút' },
    standardHeaders: true,
    legacyHeaders: false,
});

// PIN chỉ có 1 triệu tổ hợp -> giới hạn chặt hơn hẳn cho login/register customer
const pinLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Thử lại quá nhiều lần, vui lòng đợi ít phút' },
    standardHeaders: true,
    legacyHeaders: false,
});

// --- Customer: phone + PIN 6 số ---
router.post(
    '/register',
    pinLimiter,
    [
        body('phone').matches(/^0\d{9}$/).withMessage('Số điện thoại không hợp lệ'),
        body('pin').matches(/^\d{6}$/).withMessage('Mã PIN phải gồm đúng 6 chữ số'),
        body('fullName').optional().isString(),
    ],
    validate,
    authController.registerCustomer
);

router.post(
    '/verify-otp',
    pinLimiter,
    [
        body('phone').matches(/^0\d{9}$/).withMessage('Số điện thoại không hợp lệ'),
        body('otp').matches(/^\d{6}$/).withMessage('Mã OTP phải gồm đúng 6 chữ số'),
    ],
    validate,
    authController.verifyOtp
);

router.post(
    '/login',
    pinLimiter,
    [
        body('phone').matches(/^0\d{9}$/).withMessage('Số điện thoại không hợp lệ'),
        body('pin').matches(/^\d{6}$/).withMessage('Mã PIN phải gồm đúng 6 chữ số'),
    ],
    validate,
    authController.loginCustomer
);

// --- Station owner: email + password ---
router.post(
    '/register/owner',
    authLimiter,
    [
        body('email').isEmail().withMessage('Email không hợp lệ'),
        body('password').isLength({ min: 8 }).withMessage('Mật khẩu tối thiểu 8 ký tự'),
        body('fullName').optional().isString(),
        body('phone').optional().isString(),
    ],
    validate,
    authController.registerOwner
);

router.post(
    '/login/owner',
    authLimiter,
    [
        body('email').isEmail().withMessage('Email không hợp lệ'),
        body('password').notEmpty().withMessage('Thiếu mật khẩu'),
    ],
    validate,
    authController.loginOwner
);

// --- Dùng chung cho cả 2 role ---
router.post(
    '/refresh-token',
    [body('refreshToken').notEmpty().withMessage('Thiếu refresh token')],
    validate,
    authController.refreshToken
);

router.post(
    '/logout',
    [body('refreshToken').notEmpty().withMessage('Thiếu refresh token')],
    validate,
    authController.logout
);

module.exports = router;
