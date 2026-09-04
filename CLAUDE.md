# Backend — EV Reservation API

API Node.js/Express phục vụ 2 client: `mobile-app` (role `customer` + `station_owner`, chia theo role sau login) và `admin-web` (role `admin` + `station_owner` xem giới hạn). File này tự chứa đủ thông tin để code backend kể cả khi các file kế hoạch gốc (Project_Setup_Guide.md, Implementation_Checklist_And_Pitfalls.md...) không còn.

**Trạng thái hiện tại:** đã `npm init`, cài dependencies, có `server.js` + `src/config/prisma.js`, connect DB thành công (`GET /api/health` trả 200). Schema (10 bảng) quản lý qua **Prisma** (`prisma/schema.prisma` + `prisma/migrations/`, xem mục 3) — dự án ban đầu dùng Sequelize rồi đổi hẳn sang Prisma, không còn artifact Sequelize nào (đã xoá `src/models/`, `src/migrations/`, `.sequelizerc`). Auth đã xong — bao gồm register/login/OAuth Google+Facebook/forgot-reset-change password (`authController.js` mỏng, logic thật ở `services/tokenService.js` + `services/authService.js`, `auth.routes.js` mount vào `server.js`) — `customer` dùng `phone + PIN 6 số`, `station_owner` dùng `email + password` (xem mục 4). `stations/bookings/payments/reviews/admin` vẫn chưa làm.

---

## 1. Tech stack & lý do chọn

| Thành phần | Chọn | Vì sao |
|---|---|---|
| Runtime | Node.js 24 LTS (qua nvm-windows) | Cùng ngôn ngữ JS với mobile app (React Native), 1 team full-stack JS được |
| Framework | Express 5 | Nhẹ, quen thuộc, hệ sinh thái middleware lớn; tự động forward lỗi async route vào error handler (Express 4 không làm được việc này) |
| ORM | Prisma 7 (+ `@prisma/adapter-pg`) | Schema khai báo 1 file (`schema.prisma`), `db pull` introspect từ DB có sẵn, migration tự sinh từ diff schema, hỗ trợ transaction |
| DB chính | PostgreSQL | Quan hệ phức tạp (user–station–booking–payment), cần transaction/ACID cho booking + thanh toán |
| Cache/session | Redis | Cache trạm gần nhất, rate limiting, session |
| Realtime | Socket.io | Cập nhật trạng thái ổ sạc, booking real-time cho cả 2 client |
| Auth | JWT (access ngắn hạn + refresh dài hạn) + bcryptjs | Access token 15p giảm rủi ro lộ token, refresh 7 ngày đỡ phải login lại liên tục |
| Payment | VNPay / Momo | Phổ biến tại VN, không cần xử lý số thẻ trực tiếp (PCI) |
| Module system | CommonJS (`require`/`module.exports`) | Đồng bộ với style code mẫu trong dự án, không dùng ESM |

---

## 2. Setup từ đầu (nếu `backend/` đang rỗng)

```bash
cd backend
npm init -y

npm install express dotenv cors jsonwebtoken bcryptjs pg @prisma/client @prisma/adapter-pg axios socket.io express-validator helmet express-rate-limit ioredis
npm install -D nodemon eslint prettier jest prisma

npx prisma init --datasource-provider postgresql
```

**`.env`** (không commit — thêm vào `.gitignore`):
```
NODE_ENV=development
PORT=5000
DB_HOST=localhost
DB_PORT=5432
DB_NAME=ev_charging_db
DB_USER=postgres
DB_PASSWORD=your_password
DATABASE_URL="postgresql://postgres:your_password@localhost:5432/ev_charging_db?schema=public"
JWT_SECRET=your_super_secret_key_change_this
JWT_EXPIRE=15m
REFRESH_TOKEN_SECRET=another_super_secret_key
REFRESH_TOKEN_EXPIRE=7d
API_URL=http://localhost:5000
VNPAY_TMN_CODE=your_vnpay_code
VNPAY_HASH_SECRET=your_secret
GOOGLE_MAPS_API_KEY=your_google_maps_key
GOOGLE_CLIENT_ID=your_google_web_client_id
FACEBOOK_APP_ID=your_facebook_app_id
FACEBOOK_APP_SECRET=your_facebook_app_secret
REDIS_URL=redis://localhost:6379
```

**Lưu ý Prisma 7:** generator phải là `prisma-client-js` (không phải mặc định `prisma-client` — bản đó sinh code TypeScript, không `require()` được từ CommonJS thuần); `PrismaClient` bắt buộc truyền driver adapter (`@prisma/adapter-pg`), không tự kết nối chỉ bằng `DATABASE_URL` như bản cũ.

**`package.json` → `scripts`:**
```json
{
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js",
    "test": "jest",
    "lint": "eslint src",
    "postinstall": "prisma generate"
  }
}
```
`postinstall` đảm bảo Prisma Client tự sinh lại mỗi khi `npm install` (vd máy khác clone về) — thư mục `src/generated/prisma` là build output, đã gitignore, không commit.

**`server.js` (entry point tối thiểu):**
```javascript
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const prisma = require('./src/config/prisma');

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'Backend is running' });
});

// TODO: mount routes từ src/routes/*.routes.js
// TODO: mount error handler middleware CUỐI CÙNG

const PORT = process.env.PORT || 5000;

prisma
  .$connect()
  .then(() => {
    console.log('Database connection OK');
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Unable to connect to database:', err.message);
    process.exit(1);
  });
```

**`src/config/prisma.js`** (Prisma Client singleton — app + mọi service/controller đều `require('../config/prisma')` từ đây, không tự `new PrismaClient()` chỗ khác):
```javascript
const { PrismaClient } = require('../generated/prisma');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

module.exports = prisma;
```

## Bash commands

```
docker compose up -d      # khởi động Postgres + Redis + pgAdmin (chạy từ trong backend/, nơi có docker-compose.yml)
docker compose down       # tắt container, giữ nguyên data (volume không bị xoá)
docker compose ps         # xem container nào đang chạy, cổng nào

npm install     # cài dependencies
npm run dev     # chạy server với nodemon, http://localhost:5000
npm start       # chạy production
npm test        # chạy toàn bộ test (jest)
npx jest path/to/file.test.js   # chạy 1 file test khi debug — nhanh hơn cả suite
npm run lint    # eslint src/

npx prisma generate       # sinh lại Prisma Client sau khi sửa schema.prisma
npx prisma migrate dev --name ten-migration   # tạo + áp dụng migration mới (dev)
npx prisma migrate deploy                     # áp dụng migration khi deploy (production)
npx prisma migrate status                     # xem migration nào đã/chưa áp dụng
npx prisma studio                             # mở GUI xem/sửa data (thay thế pgAdmin cho việc xem nhanh)
npx prisma db pull                            # đọc schema từ DB thật, sync ngược vào schema.prisma
```

---

## 3. Database schema

10 bảng: `users, vehicles, car_brands, car_models, stations, chargers, bookings, payments, reviews, refresh_tokens` (PostgreSQL). 1 user có thể có nhiều xe (`vehicles`, không lưu thẳng trên `users`); `vehicles.model_id` trỏ vào catalog `car_models` (thuộc `car_brands`) — catalog tự lớn dần khi user gõ hãng/dòng xe lạ (`is_verified = false`, admin duyệt sau); `bookings.vehicle_id` biết đặt lịch này dùng xe nào. Access token (JWT) là stateless, không lưu DB; refresh token lưu hash trong `refresh_tokens` để revoke được từng session.

**Nguồn sự thật của schema là `prisma/schema.prisma`** — 1 file khai báo toàn bộ 10 model + quan hệ + enum, thay cho việc rải rác 10 file model tay như Sequelize. Đổi schema thì sửa file này, chạy `npx prisma migrate dev --name ten-migration` (xem Bash commands ở trên) — Prisma tự diff, tự sinh SQL migration vào `prisma/migrations/`, tự áp dụng, không cần tự tay viết `up`/`down` như Sequelize. DB rỗng mới tạo (vd máy khác, hoặc `docker compose down -v`) thì chạy `npx prisma migrate deploy` để dựng lại toàn bộ. [DATABASE.md](DATABASE.md) là bản mô tả SQL dễ đọc song song, cập nhật cùng lúc mỗi khi đổi `schema.prisma` (xem `.claude/rules/backend-workflow.md`) — nhưng khi có sai khác, `schema.prisma` mới là chuẩn.

Tên bảng/cột thật trong Postgres vẫn giữ `snake_case` (`password_hash`, `full_name`...) như trước — Prisma dùng `@map`/`@@map` để field/model phía JS là `camelCase`/`PascalCase` (`passwordHash`, `User`...) mà không đổi DB, giữ đúng convention JS đã thống nhất trong dự án.

---

## 4. API endpoints

```
# Authentication
POST   /api/auth/register        # customer: phone + pin (6 số), gửi OTP qua Redis, chưa tạo User
POST   /api/auth/verify-otp      # customer: xác nhận OTP, mới thật sự tạo User + đăng nhập luôn
POST   /api/auth/register/owner  # station_owner: email + password
POST   /api/auth/login           # customer: phone + pin
POST   /api/auth/login/owner     # station_owner: email + password
POST   /api/auth/google          # customer: OAuth Google (tự tạo user nếu email chưa có)
POST   /api/auth/google/owner    # station_owner: OAuth Google
POST   /api/auth/facebook        # customer: OAuth Facebook (tự tạo user nếu email chưa có)
POST   /api/auth/facebook/owner  # station_owner: OAuth Facebook
POST   /api/auth/forgot-password        # customer: gửi OTP về phone (không tiết lộ phone có tồn tại hay không)
POST   /api/auth/reset-password         # customer: phone + otp + newPin
POST   /api/auth/forgot-password/owner  # station_owner: gửi OTP về email
POST   /api/auth/reset-password/owner   # station_owner: email + otp + newPassword
POST   /api/auth/refresh-token   # dùng chung 2 role, rotate refresh token mỗi lần gọi
POST   /api/auth/logout          # dùng chung 2 role
POST   /api/auth/forgot-password

# Users
GET    /api/users/me
PUT    /api/users/me
GET    /api/users/:id

# Vehicles (xe của chính user đang login)
GET    /api/vehicles/me
POST   /api/vehicles              # model_id có sẵn trong catalog, hoặc gửi kèm brandName/modelName mới → auto-tạo car_brands/car_models is_verified=false
PUT    /api/vehicles/:id          # chỉ xe của chính mình
DELETE /api/vehicles/:id          # chỉ xe của chính mình

# Car catalog (dropdown khi thêm xe — public read, không cần chọn role)
GET    /api/car-brands
GET    /api/car-brands/:id/models

# Stations
GET    /api/stations              # filter, search
GET    /api/stations/:id
GET    /api/stations/nearby
POST   /api/stations              # role: station_owner
PUT    /api/stations/:id          # role: station_owner, chỉ trạm của chính mình

# Bookings
POST   /api/bookings
GET    /api/bookings/me
GET    /api/bookings/:id
PUT    /api/bookings/:id
DELETE /api/bookings/:id
GET    /api/bookings/station/:id  # role: station_owner, chỉ trạm của chính mình

# Payments
POST   /api/payments/create
GET    /api/payments/:id
GET    /api/payments/history

# Reviews
POST   /api/reviews
GET    /api/reviews/station/:id

# Admin (role: admin only)
GET    /api/admin/dashboard
GET    /api/admin/users
GET    /api/admin/stations
GET    /api/admin/payments
PUT    /api/admin/car-brands/:id  # duyệt/gộp brand is_verified=false
PUT    /api/admin/car-models/:id  # duyệt/gộp model is_verified=false
```

---

## 5. Cấu trúc thư mục

```
backend/
├── prisma/
│   ├── schema.prisma   # nguồn sự thật của schema — 10 model + quan hệ + enum
│   └── migrations/     # SQL migration Prisma tự sinh (đừng sửa tay)
├── docs/               # tài liệu chi tiết implementation (không auto-load, chỉ để đọc)
│   ├── auth/           # OTP_FLOW.md, GOOGLE_AUTH_FLOW.md, FACEBOOK_AUTH_FLOW.md, FORGOT_RESET_PASSWORD_FLOW.md, CHANGE_PASSWORD_FLOW.md
│   └── CI_CD_Workflow.md
└── src/
    ├── config/         # prisma.js (Prisma Client singleton), env config
    ├── generated/      # prisma/ — Prisma Client tự sinh, gitignore, không commit, không sửa tay
    ├── routes/         # auth.routes.js, stations.routes.js, bookings.routes.js, payments.routes.js, admin.routes.js
    ├── controllers/    # authController.js (mỏng — chỉ orchestration, logic thật nằm ở services/), stationController.js, bookingController.js, paymentController.js
    ├── middleware/      # auth.middleware.js, errorHandler.js, validators.js
    └── services/        # tokenService.js (JWT/refresh token), authService.js (bcrypt/OTP/find-or-create user/revoke session), googleAuthService.js, facebookAuthService.js — paymentService.js, notificationService.js, emailService.js (chưa làm)
```

Nguyên tắc: **route** chỉ định tuyến + gắn middleware → **controller** chứa business logic, gọi Prisma Client (`req.app` không cần, `require('../config/prisma')` trực tiếp) + service → **service** gọi API/service ngoài (VNPay, email, push notification). Không còn thư mục `models/` — Prisma không cần file model riêng, `prisma.user`, `prisma.vehicle`... có sẵn từ Prisma Client sinh ra theo `schema.prisma`.

---

## 6. Code style, pitfall, testing, security

Toàn bộ rule chi tiết (code convention, pitfall thường gặp, quy trình khi sửa code, checklist trước khi launch, thiết kế API) đã chuyển vào `.claude/rules/` — Claude Code **tự động nạp** các file này khi đọc/sửa file trong `backend/`, không cần đọc tay:

- [`.claude/rules/backend.md`](.claude/rules/backend.md) — code convention + pitfall (double booking, N+1, JWT/refresh token, IDOR, VNPay/Momo IPN...) + rule testing
- [`.claude/rules/backend-workflow.md`](.claude/rules/backend-workflow.md) — quy trình khi thêm/sửa endpoint, bảng, env var + checklist trước khi launch (rate limit, HTTPS, secrets, security audit)
- [`.claude/rules/backend-api-design.md`](.claude/rules/backend-api-design.md) — naming resource, status code, response shape

Test runner: Jest — `npm test` (toàn bộ), `npx jest path/to/file.test.js` (1 file khi debug).
