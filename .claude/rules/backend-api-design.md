---
paths:
  - "src/routes/**/*.js"
  - "src/controllers/**/*.js"
---

# API Design Rules

- Đặt tên resource bằng danh từ số nhiều: `/api/stations`, `/api/bookings` — không dùng động từ trong URL (không `/api/getStations`)
- Dùng đúng ngữ nghĩa HTTP method: GET đọc, POST tạo, PUT/PATCH sửa, DELETE xoá — không dùng POST cho mọi thao tác
- Status code đúng nghĩa: `200` OK, `201` Created (khi tạo mới thành công), `400` input không hợp lệ, `401` chưa đăng nhập/token invalid, `403` đã đăng nhập nhưng không đủ quyền (vd `station_owner` đụng trạm không phải của mình), `404` không tìm thấy, `500` lỗi server
- Response shape nhất quán toàn bộ API — cùng 1 dạng envelope (vd `{ data }` khi thành công, `{ error }` khi lỗi) cho mọi endpoint, không để mỗi route tự bịa format riêng
- Field trong response dùng `camelCase` nhất quán ở tầng API, kể cả khi cột DB là `snake_case` (Prisma `@map`/`@@map` trong `schema.prisma` tự lo việc dịch) — không để lẫn `snake_case`/`camelCase` giữa các endpoint
- Endpoint dành riêng cho 1 role thì thể hiện rõ trong path (vd `/api/admin/*` chỉ role `admin`, `/api/bookings/station/:id` chỉ role `station_owner`) thay vì 1 endpoint dùng chung rồi if/else theo role bên trong controller
- Endpoint mới phải theo đúng nhóm resource & pattern đã liệt kê trong `backend/CLAUDE.md` (mục "API endpoints") — không tạo nhóm resource mới tuỳ tiện; nếu thực sự cần nhóm mới, cập nhật danh sách đó trong cùng lần sửa (xem `backend-workflow.md`)
- List endpoint (`GET /api/stations`, `GET /api/bookings/me`...) nhận `page`/`limit` qua query string, không qua body
