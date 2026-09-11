const { sanitizeUser } = require('./authService');

test('sanitizeUser bỏ passwordHash ra khỏi object user', () => {
    const userTuDB = { id: 'abc', phone: '0912345678', passwordHash: 'hash-bi-mat' };

    const ketQua = sanitizeUser(userTuDB);

    expect(ketQua).toEqual({ id: 'abc', phone: '0912345678' });
});
