const { OAuth2Client } = require('google-auth-library');

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

async function verifyGoogleToken(idToken) {
    // Gửi token cho Google Library, kiểm tra 3 thư mục
    // 1. Chữ ký
    // 2. hạn dùng
    // 3. audience: token này có đúng là được cấp cho app không
    const ticket = await client.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID
    });

    return ticket.getPayload();
}


module.exports = { verifyGoogleToken }
