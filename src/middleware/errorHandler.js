const AppError = require('../utils/AppError');

function errorHandler(err, req, res, next) {
    const isKnownError = err instanceof AppError;
    const statusCode = isKnownError ? err.statusCode : 500;
    const message = isKnownError ? err.message : 'Internal server error';

    if (!isKnownError) {
        console.error(err);
    }

    res.status(statusCode).json({ error: message });
}

module.exports = errorHandler;