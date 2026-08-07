# Kế hoạch — Auth (Đăng ký / Đăng nhập / JWT)

Bước tiếp theo sau khi có schema Prisma đầy đủ (10 model). Auth làm trước vì mọi route khác (`vehicles`, `bookings`, `stations`...) đều cần `req.user` từ đây.

Tham khảo khi làm: [DATABASE.md](DATABASE.md) mục "Auth flow với refresh_tokens", [.claude/rules/backend.md](.claude/rules/backend.md) (IDOR, bcrypt, JWT), [CLAUDE.md](CLAUDE.md) mục "API endpoints".

## Việc cần làm

- [x] `src/middleware/auth.middleware.js` — verify JWT từ header `Authorization: Bearer <token>` (dùng `JWT_SECRET`), gắn `req.user` nếu hợp lệ; trả `401` nếu thiếu/sai/hết hạn token (còn bug `requireRole` so sánh mảng, cần sửa trước khi dùng ở `stations`/`admin`)
- [x] `src/controllers/authController.js` — tách theo role thay vì 1 hàm chung:
  - [x] `registerCustomer`/`loginCustomer` — `customer` dùng `phone + PIN 6 số`
  - [x] `registerOwner`/`loginOwner` — `station_owner` dùng `email + password`
  - [x] `refreshToken` — có rotate (revoke token cũ + cấp token mới mỗi lần gọi, chống refresh token reuse)
  - [x] `logout` — set `revokedAt = now()` cho đúng row theo `tokenHash` (chỉ logout đúng thiết bị đó)
- [x] `src/routes/auth.routes.js` — 6 route (`/register`, `/login`, `/register/owner`, `/login/owner`, `/refresh-token`, `/logout`), `express-validator` + `express-rate-limit` (chặt hơn cho PIN)
- [x] Mount `auth.routes.js` vào `server.js`
- [x] Test tay: `register`/`login` (cả customer + owner) → `refresh-token` (xác nhận rotate + token cũ bị revoke khi dùng lại) → `logout` (xác nhận idempotent) — chạy OK ngày 2026-08-04, sau khi phát hiện + fix: Node đang active là v16 (Prisma 7 cần 18+, đã `nvm use 24.18.0`)
- [ ] `admin` không có endpoint đăng ký public — tạo qua script `scripts/createAdmin.js` (chạy tay 1 lần, không phải route)

## Việc tiếp theo cho Auth (đã bàn hướng làm, chưa code)

- [ ] Xác thực OTP khi `registerCustomer`: tách 2 bước — `POST /api/auth/register` sinh OTP 6 số, lưu tạm `phone+pin+otpHash` vào **Redis** (TTL ~5-10p, chưa tạo `User` thật) + gửi SMS; `POST /api/auth/verify-otp` xác nhận đúng thì mới `prisma.user.create`. Cần `src/config/redis.js` (chưa có) — làm OTP giả (`console.log`) trước, chọn nhà cung cấp SMS thật (eSMS/SpeedSMS/Twilio...) sau
- [ ] Đăng nhập OAuth2 (Google, Apple, Facebook) cho cả 2 role: verify token từ SDK native phía mobile app, tìm/tạo `User` theo `email`, rồi gọi lại `issueTokens()` có sẵn — không dùng Firebase Auth, tránh 2 nguồn sự thật song song với JWT tự viết

## Sau Auth (chưa làm, ghi để nhớ thứ tự)

1. `vehicles` + `car-brands`/`car-models` (catalog tự lớn dần, `is_verified`)
2. `stations` + `chargers`
3. `bookings` (transaction chống double-booking — xem rule `backend.md`)
4. `payments` (transaction cùng bookings, verify IPN VNPay/Momo)
5. `reviews`
6. `admin` routes (dashboard, duyệt catalog xe)
