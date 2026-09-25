const bcrypt = require('bcryptjs');

// Thay ../config/prisma bằng 1 bản giả (deep mock) - không đụng Postgres thật.
// Đặt TRƯỚC dòng require('./authController') vì Jest cần biết "khi ai đó
// require('../config/prisma') thì trả về cái gì" trước khi authController.js
// (và tokenService.js, authService.js bên trong nó) tự require file đó.
jest.mock('../config/prisma', () => require('jest-mock-extended').mockDeep());

// authController.js cũng require('../config/redis') ngay khi load file - nếu
// không mock, ioredis sẽ cố kết nối Redis thật (không có) và làm rối log/test.
// changePasswordHandler không dùng tới redis nên chỉ cần 1 object rỗng là đủ.
jest.mock('../config/redis', () => ({}));

const prisma = require('../config/prisma');
const authController = require('./authController');
const { hashToken } = require('../services/tokenService');

describe('changePasswordCustomer', () => {
    // Xoá lịch sử gọi của mọi mock sau mỗi test -> test sau không bị ảnh hưởng
    // bởi lần gọi của test trước (mỗi test phải độc lập, chạy thứ tự nào cũng
    // ra cùng kết quả).
    beforeEach(() => {
        jest.clearAllMocks();
    });

    function buildReqRes({ currentPin, newPin, storedPasswordHash }) {
        const req = {
            user: { id: 'user-1', role: 'customer' },
            body: { currentPin, newPin, refreshToken: 'fake-refresh-token' },
        };
        const res = { json: jest.fn() };
        const next = jest.fn();

        // Giả lập: prisma.user.findUnique sẽ trả về đúng user này,
        // bất kể gọi với where gì (mockResolvedValue áp dụng cho MỌI lần gọi).
        prisma.user.findUnique.mockResolvedValue({
            id: 'user-1',
            role: 'customer',
            passwordHash: storedPasswordHash,
        });

        return { req, res, next };
    }

    test('từ chối khi gõ sai mật khẩu cũ, không đổi gì cả', async () => {
        const realHash = await bcrypt.hash('111111', 12); // PIN thật đang lưu trong DB (giả lập) là "111111"

        const { req, res, next } = buildReqRes({
            currentPin: '000000', // <-- cố tình gõ SAI
            newPin: '999888',
            storedPasswordHash: realHash,
        });

        await authController.changePasswordCustomer(req, res, next);

        // 1. Phải báo lỗi qua next(), không phải trả thành công qua res.json()
        expect(next).toHaveBeenCalledTimes(1);
        const errorArg = next.mock.calls[0][0];
        expect(errorArg.message).toBe('Sai mật khẩu hiện tại');
        expect(errorArg.statusCode).toBe(401);

        // 2. Tuyệt đối không được động tới DB để đổi mật khẩu khi sai mật khẩu cũ
        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(res.json).not.toHaveBeenCalled();
    });

    test('đúng mật khẩu cũ: đổi mật khẩu + revoke phiên khác nhưng CHỪA phiên hiện tại', async () => {
        const realHash = await bcrypt.hash('111111', 12);

        const { req, res, next } = buildReqRes({
            currentPin: '111111', // <-- gõ ĐÚNG
            newPin: '999888',
            storedPasswordHash: realHash,
        });

        // Sau khi verify mật khẩu, controller tìm "phiên hiện tại" qua refreshToken
        // client gửi kèm -> giả lập tìm thấy 1 phiên hợp lệ, đúng user, chưa revoke.
        prisma.refreshToken.findUnique.mockResolvedValue({
            userId: 'user-1',
            revokedAt: null,
        });

        await authController.changePasswordCustomer(req, res, next);

        // 1. Không có lỗi nào, trả về đúng message thành công
        expect(next).not.toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith({
            data: { message: 'Đổi mật khẩu thành công' },
        });

        // 2. Có đổi passwordHash cho đúng user đang đăng nhập
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 'user-1' },
            data: { passwordHash: expect.any(String) },
        });

        // 3. Quan trọng nhất: revoke các phiên đang sống NHƯNG loại trừ (`not`)
        // đúng tokenHash của phiên hiện tại -> thiết bị vừa đổi mật khẩu không bị
        // tự đăng xuất. Đây là điểm khác biệt so với resetPassword (revoke sạch,
        // không chừa ai).
        expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
            where: {
                userId: 'user-1',
                revokedAt: null,
                tokenHash: { not: hashToken('fake-refresh-token') },
            },
            data: { revokedAt: expect.any(Date) },
        });
    });
});
