# Database Schema — EV Reservation Backend

PostgreSQL. Tham chiếu từ [CLAUDE.md](CLAUDE.md) — đọc file này khi cần biết chi tiết cột/kiểu dữ liệu của bảng, hoặc thêm field mới. Nguồn sự thật thật sự là `prisma/schema.prisma` (Prisma) — file này là bản mô tả SQL song song, dễ đọc hơn, cập nhật cùng lúc mỗi khi đổi schema (xem `.claude/rules/backend-workflow.md`). Tên bảng/cột dưới đây là tên thật trong Postgres (`snake_case`) — phía Prisma/JS gọi bằng `camelCase`/`PascalCase` qua `@map`/`@@map`, xem `prisma/schema.prisma`.

```sql
-- USERS
CREATE TABLE users (
    id UUID PRIMARY KEY,
    email VARCHAR UNIQUE NOT NULL,
    phone VARCHAR UNIQUE,
    password_hash VARCHAR,
    role ENUM('customer', 'station_owner', 'admin'),
    full_name VARCHAR,
    avatar_url VARCHAR,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

-- CAR_BRANDS
-- Catalog hãng xe, có thể tự lớn dần: user thêm hãng lạ lúc chọn xe thì is_verified = false,
-- admin duyệt/gộp trùng sau. Brand có sẵn (seed thủ công) thì is_verified = true.
CREATE TABLE car_brands (
    id UUID PRIMARY KEY,
    name VARCHAR UNIQUE NOT NULL, -- 'Tesla', 'VinFast', 'Hyundai'
    country VARCHAR,
    website_url VARCHAR,
    logo_url VARCHAR,
    is_verified BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP
);

-- CAR_MODELS
-- Cùng cơ chế is_verified như car_brands. battery_capacity ở đây chỉ là SPEC GỢI Ý
-- để điền sẵn form thêm xe — giá trị thật của từng xe (pin xuống cấp theo thời gian)
-- vẫn nằm ở vehicles.battery_capacity, user tự sửa được.
CREATE TABLE car_models (
    id UUID PRIMARY KEY,
    brand_id UUID NOT NULL REFERENCES car_brands(id),
    name VARCHAR NOT NULL, -- 'Model 3', 'VF8'
    connector_type VARCHAR, -- 'Type2', 'CCS', 'CHAdeMO'
    battery_capacity INT, -- kWh, spec gợi ý mặc định
    is_verified BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP
);

-- VEHICLES
-- 1 user có thể có nhiều xe (VD gia đình dùng chung tài khoản, hoặc user có 2 xe điện).
-- model_id trỏ sang car_models (không lưu tên xe dạng text nữa).
CREATE TABLE vehicles (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id),
    model_id UUID REFERENCES car_models(id),
    battery_capacity INT, -- kWh — nhập tay, không lấy cứng từ car_models vì pin thật xuống cấp theo thời gian
    license_plate VARCHAR,
    is_default BOOLEAN NOT NULL DEFAULT false, -- xe mặc định khi user đặt lịch, không cần chọn lại mỗi lần
    created_at TIMESTAMP
);

-- STATIONS
CREATE TABLE stations (
    id UUID PRIMARY KEY,
    owner_id UUID REFERENCES users(id),
    name VARCHAR NOT NULL,
    address VARCHAR,
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    total_outlets INT,
    connector_types VARCHAR[], -- 'Type2', 'CCS', 'CHAdeMO'
    price_per_kwh DECIMAL(5, 2),
    opening_hours VARCHAR,
    is_active BOOLEAN,
    created_at TIMESTAMP
);

-- CHARGERS
CREATE TABLE chargers (
    id UUID PRIMARY KEY,
    station_id UUID REFERENCES stations(id),
    outlet_number INT,
    connector_type VARCHAR,
    power_output INT, -- kW
    status ENUM('available', 'charging', 'maintenance'),
    created_at TIMESTAMP
);

-- BOOKINGS
CREATE TABLE bookings (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    station_id UUID REFERENCES stations(id),
    charger_id UUID REFERENCES chargers(id),
    vehicle_id UUID REFERENCES vehicles(id), -- xe nào đi sạc — trạm cần biết để xác nhận đúng khách khi tới nơi
    booking_date DATE,
    start_time TIME,
    end_time TIME,
    status ENUM('pending', 'confirmed', 'completed', 'cancelled'),
    total_amount DECIMAL(10, 2),
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

-- PAYMENTS
CREATE TABLE payments (
    id UUID PRIMARY KEY,
    booking_id UUID REFERENCES bookings(id),
    user_id UUID REFERENCES users(id),
    amount DECIMAL(10, 2),
    payment_method VARCHAR, -- 'vnpay', 'momo', 'bank'
    status ENUM('pending', 'completed', 'failed'),
    transaction_id VARCHAR,
    created_at TIMESTAMP
);

-- REVIEWS
CREATE TABLE reviews (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    station_id UUID REFERENCES stations(id),
    rating INT, -- 1-5
    comment TEXT,
    created_at TIMESTAMP
);

-- REFRESH TOKENS
-- Access token (JWT, 15p) là stateless, không lưu ở đây — verify bằng chữ ký JWT_SECRET.
-- Refresh token PHẢI lưu để revoke được từng session/thiết bị riêng lẻ (đăng xuất 1 máy,
-- vô hiệu hoá khi phát hiện token bị đánh cắp) thay vì chỉ chờ hết hạn hoặc đổi secret
-- rồi logout toàn bộ user cùng lúc.
CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    token_hash VARCHAR NOT NULL, -- hash (sha256) của refresh token, không lưu plaintext
    device_info VARCHAR,          -- user agent / tên thiết bị, hiển thị khi user xem "các phiên đăng nhập"
    expires_at TIMESTAMP NOT NULL,
    revoked_at TIMESTAMP,         -- NULL = còn hiệu lực; set khi logout hoặc phát hiện bị đánh cắp
    created_at TIMESTAMP
);
```

## Index bắt buộc

Tránh full table scan khi tra cứu lịch/trạng thái booking. Khai trực tiếp trong `prisma/schema.prisma` bằng `@@index`/`@@unique` trên từng model (không viết tay qua `queryInterface` như Sequelize nữa):

```prisma
model Booking {
  // ...
  @@index([userId], map: "idx_bookings_user_id")
  @@index([stationId], map: "idx_bookings_station_id")
  @@index([status], map: "idx_bookings_status")
  @@index([startTime], map: "idx_bookings_start_time")
  @@index([chargerId, startTime, endTime], map: "idx_bookings_charger_time") // composite, dùng để check trùng lịch khi tạo booking
  @@index([vehicleId], map: "idx_bookings_vehicle_id")
}

model RefreshToken {
  // ...
  tokenHash String @unique(map: "idx_refresh_tokens_hash") // lookup nhanh khi verify refresh token
  @@index([userId], map: "idx_refresh_tokens_user_id")
}

model Vehicle {
  // ...
  @@index([userId], map: "idx_vehicles_user_id")
  @@index([modelId], map: "idx_vehicles_model_id")
}

model CarModel {
  // ...
  @@index([brandId], map: "idx_car_models_brand_id")
}
```

Toàn bộ index trên đã có sẵn trong `prisma/schema.prisma` thật — đoạn trên chỉ để tham khảo nhanh, không cần copy lại.

## Quan hệ chính

`users (1) → stations (n)` qua `owner_id` · `stations (1) → chargers (n)` · `car_brands (1) → car_models (n)` · `users (1) → vehicles (n)` (1 user có thể có nhiều xe) · `car_models (1) → vehicles (n)` qua `model_id` · `users + stations + chargers + vehicles → bookings` · `bookings (1) → payments (1)` · `users + stations → reviews` · `users (1) → refresh_tokens (n)` (1 user có nhiều session/thiết bị).

## Catalog xe tự lớn dần (car_brands / car_models)

1. User thêm xe → chọn hãng + dòng xe từ dropdown (nạp từ `car_brands`/`car_models` có `is_verified = true` trước)
2. Không thấy hãng/dòng xe mình cần → cho gõ tên mới → tạo luôn 1 dòng mới trong `car_brands`/`car_models` với `is_verified = false`, dùng ngay cho xe của user đó
3. User khác gõ trùng tên sau này → đã thấy trong dropdown (kể cả khi chưa verify), không phải nhập lại
4. Admin định kỳ vào duyệt/gộp các dòng `is_verified = false` trùng nhau (vd "Model 3" vs "Tesla Model3") — không chặn người dùng lúc thêm xe

## Auth flow với refresh_tokens

1. Login thành công → tạo access token (JWT 15p, stateless) + refresh token (random string hoặc JWT 7 ngày) → lưu `sha256(refresh_token)` vào bảng này, trả refresh token gốc (plaintext) về client
2. `POST /auth/refresh-token` → hash token client gửi lên, tìm trong bảng theo `token_hash`, kiểm tra `revoked_at IS NULL` và `expires_at > now()` → cấp access token mới
3. `POST /auth/logout` → set `revoked_at = now()` cho đúng row (theo `token_hash`) — chỉ logout đúng thiết bị đó, không ảnh hưởng phiên khác
4. "Đăng xuất tất cả thiết bị" → set `revoked_at = now()` cho toàn bộ row của `user_id`
5. Refresh token cũ bị dùng lại sau khi đã revoke → dấu hiệu bị đánh cắp, nên revoke luôn toàn bộ session của user đó
