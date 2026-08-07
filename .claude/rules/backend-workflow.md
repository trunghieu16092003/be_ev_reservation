---
paths:
  - "**/*.js"
---

# Backend Workflow

- Thêm/sửa endpoint → cập nhật luôn mục "API endpoints" trong `backend/CLAUDE.md` cùng lần sửa, không để tài liệu lệch code
- Thêm/sửa bảng hoặc cột → sửa `prisma/schema.prisma` trước, rồi `npx prisma migrate dev --name ten-migration` (Prisma tự diff + tự sinh SQL migration + tự áp dụng) — không sửa DB tay (`docker exec`/`psql`) rồi để `schema.prisma` tự lệch; đồng thời cập nhật mô tả trong `backend/DATABASE.md`
- Thêm biến môi trường mới → cập nhật cả `.env.example` và mục "Biến môi trường bắt buộc" trong `backend/CLAUDE.md`
- Trước khi coi 1 thay đổi là xong: chạy `npm run lint` và test liên quan (`npx jest path/to/file.test.js`) — không chỉ dựa vào "chạy được là xong"
- Sau khi sửa route/middleware, verify lại bằng cách gọi thử endpoint (hoặc `GET /api/health`) — không suy đoán là nó chạy đúng
- Trước khi launch: bật `express-rate-limit` cho `/auth/login` và `/auth/register` để chống brute-force
- Trước khi launch: bắt buộc HTTPS everywhere, không hardcode secret (luôn qua `.env`), lên lịch security audit định kỳ
- Implement graceful shutdown (lắng nghe `SIGTERM`) — gọi `prisma.$disconnect()` và đóng Redis connection trước khi process thoát, tránh rớt kết nối giữa transaction
- `/auth/logout`: JWT không tự thu hồi được — lưu access token đã logout vào Redis blocklist tới khi hết hạn tự nhiên, để logout thật sự vô hiệu hoá token
