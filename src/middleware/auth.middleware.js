const jwt = require('jsonwebtoken');
const AppError = require('../utils/AppError');

const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return next(new AppError('Unauthorized', 401));
    }
    const token = authHeader.split(' ')[1];
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        req.user = payload;
        next();
    } catch (error) {
        next(new AppError('Invalid token', 401));
    }
}

const requireRole = (...role) => {
    return (req, res, next) => {
        if (req.user.role !== role) {
            return next(new AppError('Forbidden', 403));
        }
        next();
    }
}

module.exports = { authMiddleware, requireRole }