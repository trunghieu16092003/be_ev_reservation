---
paths:
  - "**/*.js"
---

# Backend Rules (Express + Prisma)

- CommonJS only: `require`/`module.exports` — không dùng `import`/`export`
- Route không tự verify JWT — luôn đi qua `middleware/auth.middleware.js`
- Query luôn qua Prisma Client (`require('../config/prisma')`) — không viết raw SQL trừ khi thật sự cần (`$queryRaw`/`$executeRaw` dùng template tag, tự parameterize, không nối chuỗi)
- Controller mỏng — chỉ orchestration (parse `req`, gọi service, format `res`); logic dùng lại nhiều nơi (băm/so mật khẩu, ký JWT, tạo/rotate/revoke refresh token, OAuth find-or-create user...) đưa vào `services/*.js` (vd `tokenService.js`, `authService.js`). Query Prisma đơn giản, chỉ dùng đúng 1 chỗ (tìm user theo id/phone/email để check tồn tại...) thì để thẳng trong controller, không bắt buộc phải bọc qua service
- Phân quyền theo `req.user.role` filter ngay trong `where` của query, không lấy hết data rồi lọc sau
- `station_owner` chỉ được đọc/sửa record có `ownerId === req.user.id` (station) hoặc thuộc trạm của họ (booking, charger)
- Lỗi throw lên để `errorHandler.js` xử lý tập trung — không tự `try/catch` rồi `res.json` lỗi rải rác trong từng controller
- Input validate bằng `express-validator` ở tầng route, trước khi vào controller
- List endpoint luôn phân trang qua `page`/`limit`, cap `limit` tối đa 100
- Logic tạo booking + xử lý payment bọc trong Prisma **interactive transaction** (`prisma.$transaction(async (tx) => {...})`) — Prisma không có option `lock: true` tiện như Sequelize, phải tự `tx.$queryRaw` với `SELECT ... FOR UPDATE` để lock row trước khi check trùng lịch, rồi mới `tx.booking.create(...)` trong cùng transaction đó
- Không log `req.body` thô (chứa password), không lưu số thẻ/CVV, không trả `passwordHash` ra response
- Query nhiều bản ghi liên quan dùng `include` (eager loading) hoặc `where: { id: { in: [...] } }` (batch) — tránh N+1 query trong vòng lặp
- Dùng Express 5 — route async không cần tự try/catch, lỗi/Promise reject tự động forward vào error handler cuối cùng (khác Express 4). Chỉ cần try/catch tay khi muốn xử lý lỗi riêng biệt ngay tại chỗ (vd trả message khác nhau tuỳ loại lỗi)
- Không tin `user_id`/`owner_id` gửi từ client (`req.body`/query param) — luôn lấy từ `req.user.id` sau khi verify JWT, tránh IDOR (user A sửa được data của user B)
- Password hash bằng `bcrypt` trước khi lưu, so sánh bằng `bcrypt.compare` — không bao giờ so sánh plaintext
- CORS chỉ whitelist origin thật của `mobile-app`/`admin-web` — không dùng `cors()` mặc định (mở toàn bộ origin)
- Set `helmet()` middleware ngay từ đầu để có secure HTTP header mặc định
- Endpoint nhận callback/IPN từ VNPay/Momo phải verify secure hash/signature của gateway trước khi tin dữ liệu — không update `payments`/`bookings` chỉ dựa vào param thô trong request
- Test logic nhạy cảm với transaction (booking, payment) trên DB test riêng hoặc mock Prisma Client (vd `jest-mock-extended`) — không test trên DB dev có data thật
