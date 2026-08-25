const axios = require('axios');

async function verifyFacebookToken(fbAccessToken) {
    // 1. Kiểm tra token có đúng cấp cho app của mình không (tương đương check `audience` bên Google)
    const appAccessToken = `${process.env.FACEBOOK_APP_ID}|${process.env.FACEBOOK_APP_SECRET}`;
    const debugRes = await axios.get('https://graph.facebook.com/debug_token', {
        params: { input_token: fbAccessToken, access_token: appAccessToken },
    });

    const tokenData = debugRes.data.data;
    if (!tokenData.is_valid || tokenData.app_id !== process.env.FACEBOOK_APP_ID) {
        throw new Error('Facebook token không hợp lệ');
    }

    // 2. Lấy thông tin user thật
    const userRes = await axios.get('https://graph.facebook.com/me', {
        params: { fields: 'id,name,email', access_token: fbAccessToken },
    });

    return userRes.data; // { id, name, email }
}

module.exports = { verifyFacebookToken };
