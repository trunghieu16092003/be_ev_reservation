# Tìm trạm gần tôi — giải thích logic `findNearby`

File này giải thích **tại sao** `stationService.findNearby()` viết như vậy: toán học đằng sau, lý do chia 2 tầng lọc, và các bẫy kỹ thuật. Đọc file này trước khi sửa hàm đó. Phần nghiệp vụ (ai thấy trạm nào) xem [STATION_FLOW.md](STATION_FLOW.md) mục 2 và 8.

---

## 1. Bài toán

Khách đứng ở Bến Thành (Quận 1, TP.HCM), mở app, muốn thấy các trạm sạc **trong bán kính 5 km**, sắp xếp gần → xa, kèm số km.

Dữ liệu có: bảng `stations` với 2 cột `latitude`, `longitude`.

Điều **không** có: cột "khoảng cách". Khoảng cách phụ thuộc vị trí khách — mỗi khách một chỗ, mỗi lần mở app một chỗ — nên không thể lưu sẵn, phải tính lúc truy vấn.

Prisma Client (`findMany`) không có hàm tính khoảng cách địa lý → phải viết SQL thô bằng `$queryRaw`.

---

## 2. Toạ độ: hai con số đó nghĩa là gì

| | Ý nghĩa | Khoảng giá trị |
|---|---|---|
| **Vĩ độ** (latitude, ký hiệu φ) | Cách xích đạo bao nhiêu độ về bắc/nam | −90 (Nam Cực) → 0 (xích đạo) → +90 (Bắc Cực) |
| **Kinh độ** (longitude, ký hiệu λ) | Cách kinh tuyến gốc Greenwich bao nhiêu độ về đông/tây | −180 → 0 (Greenwich) → +180 |

Ví dụ:

| Nơi | Vĩ độ | Kinh độ |
|---|---|---|
| Bến Thành, TP.HCM | 10.7769 | 106.7009 |
| Hoàn Kiếm, Hà Nội | 21.0285 | 105.8542 |
| Đà Nẵng | 16.0544 | 108.2022 |

Hai số này là **dữ liệu**, không tính ra được:
- Của khách: do GPS điện thoại trả về, app gửi lên qua `?lat=10.7769&lng=106.7009`.
- Của trạm: do owner chọn trên bản đồ lúc tạo trạm, lưu trong DB.

Trong code, tham số `lat` của `findNearby` **chính là φ** trong các công thức bên dưới.

---

## 3. Vì sao không dùng định lý Pythagore

Trên mặt phẳng, khoảng cách là `√(Δx² + Δy²)`. Trái Đất là hình cầu, nên công thức đó sai — càng xa xích đạo càng sai nhiều, vì 1 độ kinh độ ở Hà Nội ngắn hơn ở TP.HCM (xem mục 5).

Công thức đúng cho khoảng cách giữa 2 điểm trên mặt cầu, gọi là **định lý cosin cầu** (spherical law of cosines):

```
d = R × acos( sin φ₁ · sin φ₂ + cos φ₁ · cos φ₂ · cos(λ₂ − λ₁) )
```

- `R` = bán kính Trái Đất = **6371 km** → kết quả ra km.
- `φ₁, λ₁` = vị trí khách; `φ₂, λ₂` = vị trí trạm.
- `sin`, `cos` nhận **radian**, dữ liệu là **độ** → phải bọc `radians(...)` (SQL) hoặc `× π/180` (JS).

> **Lưu ý về tên gọi.** Công thức này hay bị gọi nhầm là *Haversine*. Haversine là công thức khác:
> ```
> a = sin²(Δφ/2) + cos φ₁ · cos φ₂ · sin²(Δλ/2)
> d = 2R · atan2(√a, √(1−a))
> ```
> Hai công thức cho **cùng kết quả** ở khoảng cách bình thường. Kiểm chứng thực tế với `float8`:
>
> | Cặp điểm | Cosin cầu | Haversine | Lệch |
> |---|---|---|---|
> | Bến Thành → Thảo Điền | 4.956017 km | 4.956017 km | < 0.1 mm |
> | Bến Thành → Thủ Đức | 9.911933 km | 9.911933 km | < 0.1 mm |
> | Hai điểm cách ~10 m | 0.014028 km | 0.014029 km | 0.3 mm |
>
> Haversine ổn định hơn ở khoảng cách **rất nhỏ** (dưới vài mét) — thời máy tính dùng số thực 32-bit thì đây là khác biệt thật. Với `float8` và bài toán tìm trạm theo km, cosin cầu ngắn hơn, dễ đọc hơn, sai số không đáng kể. Nếu sau này cần đo chính xác dưới mét (ví dụ xác định khách đã tới đúng trụ chưa) thì đổi sang Haversine hoặc PostGIS.

---

## 4. Vì sao không chỉ dùng mỗi công thức đó

Viết thẳng được:

```sql
SELECT *, <cosin cầu> AS dist FROM stations WHERE <cosin cầu> <= 5
```

Nhưng Postgres phải **tính lượng giác cho từng dòng của cả bảng** mới biết dòng nào thoả. 10.000 trạm = 10.000 lần `acos`, `sin`, `cos`. Và **không dùng được index**: index B-tree chỉ giúp so sánh trực tiếp trên cột (`lat > 10.7`), không giúp cho biểu thức phức tạp.

Càng nhiều trạm, query càng chậm tuyến tính.

---

## 5. Giải pháp tầng 1: lọc thô bằng hình vuông (bounding box)

**Ý tưởng:** trước khi tính lượng giác, vứt bỏ ngay những trạm *chắc chắn ở xa* bằng phép so sánh đơn giản trên `latitude`/`longitude` — loại so sánh mà index `idx_stations_lat_lng` giúp được.

```
     lng−Δlng                    lng+Δlng
        │                            │
lat+Δlat├────────────────────────────┤   ┐
        │        ╭──────────╮        │   │  hình vuông: lọc thô, dùng index
        │      ╱              ╲      │   │
        │     │       ●khách   │     │   │  hình tròn: bán kính thật khách xin
        │      ╲              ╱      │   │
        │        ╰──────────╯        │   │
lat−Δlat├────────────────────────────┤   ┘
```

Trạm ngoài hình vuông thì chắc chắn ngoài hình tròn → loại luôn, khỏi tính. Chỉ số ít trạm trong hình vuông mới phải tính khoảng cách thật.

### 5.1 Δlat — đổi km sang độ vĩ

Công thức chung: `số độ = số km ÷ (số km mỗi độ)`.

Các đường vĩ tuyến **song song và cách đều** ở mọi nơi trên Trái Đất. Chu vi Trái Đất ≈ 40.075 km, chia 360° → **1 độ vĩ ≈ 111 km**, ở đâu cũng vậy.

```js
const dLat = radiusKm / 111;        // 5 / 111 = 0.045045 độ
```

### 5.2 Δlng — đổi km sang độ kinh (chỗ khó)

Các đường kinh tuyến **không** song song — chúng chụm lại ở hai cực, như múi cam:

```
        Bắc Cực
          ╱│╲          ← mọi kinh tuyến gặp nhau tại đây
         ╱ │ ╲
        │  │  │        ← xích đạo: xa nhau nhất
         ╲ │ ╱
          ╲│╱
        Nam Cực
```

**Thí nghiệm tưởng tượng cho dễ thấy:**

- Đứng ở xích đạo, đi về đông 1° kinh độ → bạn đi **111 km**.
- Đứng cách Bắc Cực đúng 1 mét, đi về đông 1° kinh độ → bạn đi quanh một vòng tròn bán kính 1 m: chu vi `2π × 1 = 6,28 m`, một độ là `6,28 ÷ 360 =` **1,7 cm**.

Cùng "1 độ kinh độ", chỗ này 111 km, chỗ kia 1,7 cm.

**Vì sao — hệ số `cos`.** Cắt đôi Trái Đất nhìn từ cạnh:

```
              N
              │
        ┌─────┼─────┐
       ╱   r  │      ╲       ← vòng tròn tại vĩ độ φ, bán kính r
      ╱───●───┼       ╲
     ╱     ╲  │φ       ╲
    │───────╲─●─────────│    ← xích đạo, bán kính R = 6371 km
     ╲       ╱│╲       ╱
      ╲     ╱ │ ╲     ╱
       └─────┼─────┘
              S
```

Tam giác vuông có cạnh huyền `R` và góc ở tâm là `φ` (chính là vĩ độ). Cạnh kề — bán kính vòng tròn bạn đang đứng trên đó:

```
r = R × cos(φ)
```

Vòng tròn nhỏ đi bao nhiêu lần thì chu vi nhỏ đi bấy nhiêu, nên độ dài 1° trên vòng đó cũng ngắn đi bấy nhiêu.

**Ghép lại từng bước:**

| Bước | Công thức | Ghi chú |
|---|---|---|
| 1. Một vòng tròn bán kính `r`, 1° dài bao nhiêu | `2πr / 360` | chu vi chia 360 |
| 2. Thử với xích đạo (`r = R`) | `2π × 6371 / 360 = 111,2 km` | **số 111 từ đây ra** |
| 3. Thay `r = R·cos(φ)` | `2πR·cos(φ) / 360` | |
| 4. Tách ra | `(2πR/360) × cos(φ) = 111 × cos(φ)` | 111 là hằng số, `cos(φ)` là hệ số co |

Số thật với bán kính 5 km:

| Nơi | Vĩ độ φ | cos(φ) | km mỗi độ kinh | Δlng |
|---|---|---|---|---|
| Xích đạo | 0° | 1.0000 | 111.0 | 0.04505° |
| **TP.HCM** | **10.7769°** | **0.9824** | **109.0** | **0.04585°** |
| Hà Nội | 21.03° | 0.9334 | 103.6 | 0.04826° |
| Vĩ độ 45° | 45° | 0.7071 | 78.5 | 0.06369° |
| Oslo | 60° | 0.5000 | 55.5 | 0.09009° |

Để ý Oslo: cùng 5 km nhưng phải quét **gấp đôi** số độ kinh so với xích đạo. Bỏ `cos` đi thì ở Oslo hình vuông hẹp một nửa → **sót mất nửa số trạm**, mà không có lỗi nào báo. Ở Việt Nam sai số chỉ ~2% nên càng khó phát hiện — đúng kiểu bug âm thầm.

```js
const dLng = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
//            ────┬───   ──────────────┬──────────────────────
//             số km          số km mỗi độ kinh tại vĩ độ này
```

**Hai chỗ dễ sai:**

1. **`Math.cos` nhận radian.** Quên `× π/180` thì `Math.cos(10.78)` bị hiểu là 10,78 **radian** ≈ 617° → ra `−0.86` (số âm) → `dLng` âm → `BETWEEN lng+0.05 AND lng−0.05` → khoảng rỗng → **luôn trả về 0 trạm**.
2. **`cos` nhận vĩ độ (`lat`), không phải kinh độ.** Nghe ngược đời — tính bước nhảy *kinh độ* mà dùng *vĩ độ* — nhưng đúng: độ dài 1° kinh phụ thuộc bạn ở cao hay thấp, tức phụ thuộc vĩ độ.

**Một xấp xỉ có chủ ý:** mình dùng vĩ độ của *khách* để tính `dLng` cho cả hình vuông, dù mỗi điểm trong hình vuông có vĩ độ hơi khác. Trong 5 km, vĩ độ chỉ đổi 0,045° → `cos` gần như không đổi, sai số < 0,1%. Không đáng kể so với việc hình vuông vốn đã rộng hơn hình tròn.

Bounding box cho ví dụ Bến Thành, bán kính 5 km:

```
latitude  BETWEEN 10.7319 AND 10.8219
longitude BETWEEN 106.6550 AND 106.7468
```

---

## 6. Giải pháp tầng 2: lọc tinh bằng khoảng cách thật

Hình vuông **rộng hơn** hình tròn. Trạm ở góc hình vuông cách khách `5 × √2 ≈ 7,07 km` (tính thực tế: **7,083 km**) — vượt xa bán kính 5 km khách xin. Nên sau lọc thô vẫn phải lọc lại bằng khoảng cách thật.

**Vướng mắc cú pháp SQL:** không dùng được alias `"distanceKm"` trong `WHERE` cùng cấp, vì Postgres xử lý `WHERE` **trước** khi tạo cột output. Hai cách:

1. Chép lại nguyên công thức cosin cầu vào `WHERE` — chạy được, nhưng dài và dễ sửa một nơi quên nơi kia.
2. **Bọc subquery** — tính ở tầng trong, lọc ở tầng ngoài. Sạch hơn, và đây là cách đang dùng.

```sql
SELECT * FROM (
    SELECT ..., <cosin cầu> AS "distanceKm"
    FROM stations s
    WHERE <public> AND <bounding box>          -- tầng 1: lọc thô, dùng index
) t
WHERE t."distanceKm" <= 5                       -- tầng 2: lọc tinh
ORDER BY t."distanceKm" ASC
LIMIT 20
```

Thứ tự Postgres chạy: lọc hình vuông (index) → tính lượng giác cho số ít còn lại → cắt theo bán kính thật → sắp xếp → lấy 20.

---

## 7. Đọc code từng phần

Code ở [`src/services/stationService.js`](../../src/services/stationService.js), hàm `findNearby`.

### 7.1 Chuẩn bị tham số

```js
const dLat = radiusKm / 111;
const dLng = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
const ct = connectorType ?? null;
```

`ct` gom về `null` khi khách không lọc loại cổng — xem 7.4.

### 7.2 Danh sách cột

```sql
s.price_per_kwh AS "pricePerKwh"
```

SQL thô **không đi qua `@map`** của Prisma, nên cột trả về mang tên DB (`price_per_kwh`). Phải tự đổi sang camelCase cho khớp quy ước API ([backend-api-design.md](../../.claude/rules/backend-api-design.md)).

**Nháy kép bắt buộc:** Postgres tự hạ chữ thường nếu không có nháy — `AS pricePerKwh` sẽ ra cột tên `priceperkwh`.

### 7.3 Đếm ổ rảnh

```sql
(SELECT COUNT(*) FROM chargers c
  WHERE c.station_id = s.id AND c.status = 'available')::int AS "availableOutlets"
```

Chạy cho từng trạm — đúng việc mà hằng số `countAvailableChargers` làm ở các hàm Prisma khác trong cùng service.

**`::int` bắt buộc:** `COUNT(*)` của Postgres trả `bigint` → Prisma đưa sang JS thành `BigInt` → `JSON.stringify(BigInt)` **ném lỗi** `TypeError: Do not know how to serialize a BigInt` lúc `res.json`. Ép về `int` là hết.

Số này **không lưu sẵn** như `totalOutlets` vì nó đổi mỗi lần có người cắm/rút sạc — lưu là lệch ngay.

### 7.4 Điều kiện lọc

```sql
WHERE s.status = 'approved'
  AND s.is_active = true
  AND s.latitude  BETWEEN ${lat - dLat} AND ${lat + dLat}
  AND s.longitude BETWEEN ${lng - dLng} AND ${lng + dLng}
  AND (${ct}::text IS NULL OR ${ct}::text = ANY(s.connector_types))
```

| Điều kiện | Việc |
|---|---|
| `status = 'approved' AND is_active` | **Chốt chặn bảo mật** — khách không bao giờ thấy trạm nháp/chờ duyệt/bị khoá/tạm đóng. Đây là bản SQL thô của hằng số `PUBLIC_WHERE` |
| 2 dòng `BETWEEN` | Hình vuông. Chính 2 dòng này dùng được index `idx_stations_lat_lng` |
| Dòng cuối | Lọc loại cổng, **chỉ khi có** |

**Mẹo "lọc có điều kiện" trong SQL thô:** template string không chèn `if` giữa chừng được. Cách làm: truyền `null` khi không lọc → vế `IS NULL` đúng → cả mệnh đề `OR` đúng → không ảnh hưởng gì. Khi có giá trị, vế đầu sai, buộc phải thoả vế sau.

`::text` để Postgres biết kiểu của tham số `null`, không thì báo `could not determine data type of parameter`.

`= ANY(mảng)` là cách Postgres kiểm tra phần tử có trong mảng — chính là thứ Prisma dịch ra từ `{ has: 'CCS2' }`.

### 7.5 Công thức khoảng cách trong SQL

```sql
(6371 * acos(LEAST(1,
     cos(radians(${lat})) * cos(radians(s.latitude))
   * cos(radians(s.longitude) - radians(${lng}))
   + sin(radians(${lat})) * sin(radians(s.latitude))
))) AS "distanceKm"
```

Đúng công thức mục 3, viết bằng hàm Postgres. **`LEAST(1, ...)` là chốt chặn quan trọng:** về toán, biểu thức trong `acos` luôn ≤ 1. Nhưng số thực dấu phẩy động có sai số — khi khách đứng **đúng ngay tại trạm**, nó có thể ra `1.0000000000000002`, và `acos` của số lớn hơn 1 thì Postgres **ném lỗi**:

```
ERROR: input is out of range
```

`LEAST(1, x)` cắt ngọn về đúng 1. Đây là bug kinh điển của công thức này — chỉ xuất hiện khi khoảng cách ≈ 0, tức đúng lúc ngồi test tại chỗ, nên rất dễ tưởng là lỗi khác.

### 7.6 Chuyển kết quả về JSON

```js
return rows.map((r) => ({
    ...serialize(r),
    distanceKm: Math.round(Number(r.distanceKm) * 100) / 100,
}));
```

- `serialize(r)` — ép `latitude`, `longitude`, `pricePerKwh` từ Decimal/string về `Number`, giống mọi hàm khác trong service. Ở đây `r` không có `chargers` hay `_count` nên 2 nhánh đó của `serialize` không chạy.
- Làm tròn 2 chữ số: `0.3271849...` → `0.33`. Nhân 100 → làm tròn → chia 100.
- **Thứ tự quan trọng:** `distanceKm` viết **sau** `...serialize(r)` để đè lên giá trị gốc chưa làm tròn.

---

## 8. Điều tuyệt đối không được sửa

```js
prisma.$queryRaw`SELECT ...`      // ✅ backtick dính liền — tagged template
prisma.$queryRaw(`SELECT ...`)    // ❌ có ngoặc tròn = nối chuỗi = SQL injection
```

Ở dạng đúng, Prisma tách các `${...}` ra, gửi SQL với placeholder `$1, $2, ...` kèm danh sách giá trị riêng. Postgres không bao giờ hiểu nhầm dữ liệu thành câu lệnh.

Ở dạng sai, giá trị bị dán thẳng vào chuỗi SQL. Vì `lat`/`lng`/`radius` đến từ query string của người dùng, đây là lỗ hổng SQL injection thật sự. Yêu cầu "parameterized queries only" nằm trong [CLAUDE.md](../../../CLAUDE.md).

---

## 9. Kiểm chứng bằng số thật

Khách ở Bến Thành `(10.7769, 106.7009)`, bán kính 5 km:

```
cos(10.7769°) = 0.982363
dLat = 5 / 111              = 0.045045°
dLng = 5 / (111 × 0.982363) = 0.045854°

Hình vuông:  lat  10.7319 → 10.8219
             lng 106.6550 → 106.7468

Góc hình vuông cách khách: 7.083 km   (= 5 × √2, đúng như lý thuyết)
```

Khoảng cách tới vài điểm thật, tính bằng công thức trong code:

| Từ Bến Thành đến | Khoảng cách | Lọt hình vuông? | Lọt hình tròn? | Kết quả |
|---|---|---|---|---|
| Thảo Điền (10.8039, 106.7370) | 4.96 km | ✅ | ✅ | **Hiện** |
| Điểm gần góc đông-bắc (10.8150, 106.7400) | 6.02 km | ✅ | ❌ | Qua tầng 1, **bị tầng 2 loại** |
| Tân Bình (10.8007, 106.6529) | 5.87 km | ❌ | ❌ | Bị loại ngay tầng 1 |
| Thủ Đức (10.8494, 106.7537) | 9.91 km | ❌ | ❌ | Bị loại ngay tầng 1 |

Dòng thứ hai là minh hoạ đúng lý do cần tầng 2: điểm đó nằm trong hình vuông nhưng cách 6,02 km — vượt bán kính 5 km khách xin. Không có tầng 2 thì nó vẫn hiện ra trong kết quả.

**Cách tự kiểm tra khi code xong:** tạo 2 trạm test có toạ độ cách nhau đã biết, gọi API, so `distanceKm` trả về với kết quả đo trên Google Maps. Lệch quá 1% là có gì sai trong công thức.

---

## 10. Vì sao chưa dùng PostGIS

PostGIS là extension chuyên cho dữ liệu địa lý: có kiểu `geography`, hàm `ST_DWithin`, `ST_Distance`, và index không gian GiST (cây R-tree) lọc được cả 2 chiều cùng lúc thay vì chỉ theo vĩ độ.

**Cái giá hiện tại:**
- [`docker-compose.yml`](../../docker-compose.yml) đang dùng `postgres:15-alpine` — không có PostGIS. Phải đổi sang `postgis/postgis:15-3.4` (80 MB → ~600 MB) và recreate container.
- Prisma **không hỗ trợ kiểu `geography`** → phải khai `Unsupported("geography(Point, 4326)")`, mà field `Unsupported` thì Prisma Client không đọc/ghi được → mọi `create`/`update` trạm phải kèm `$executeRaw`.

**Cách né vướng mắc thứ hai** (nếu sau này làm): để Postgres tự sinh cột đó từ `latitude`/`longitude`:

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE stations ADD COLUMN location geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography) STORED;

CREATE INDEX idx_stations_location ON stations USING GIST (location);
```

Prisma vẫn ghi `latitude`/`longitude` như thường, Postgres tự cập nhật `location`. (Nếu Postgres từ chối vì expression không `IMMUTABLE`, phải thay bằng trigger — tuỳ phiên bản PostGIS.) Khi đó thân hàm gọn hẳn:

```sql
WHERE status = 'approved' AND is_active
  AND ST_DWithin(location, ST_MakePoint(${lng}, ${lat})::geography, ${radiusKm * 1000})
ORDER BY location <-> ST_MakePoint(${lng}, ${lat})::geography
```

**Khi nào đổi:** khi query nearby bắt đầu chậm — thường từ vài nghìn trạm trở lên. Lưu ý `ST_DWithin` nhận bán kính bằng **mét**, nên `radiusKm * 1000`.

**Lập luận "làm sớm cho đỡ migrate sau" không áp dụng ở đây.** Với `pricePerKwh` thì phải làm sớm vì sau khi có booking, đổi kiểu cột là phải chuyển đổi dữ liệu cũ. Còn PostGIS thì `latitude`/`longitude` giữ nguyên, cột `location` là cột sinh tự động — thêm lúc nào cũng chỉ là 3 câu SQL trên, không backfill, không đụng dữ liệu cũ.

---

## 11. Các bước nâng cấp khác

| Khi nào | Làm gì | Ảnh hưởng |
|---|---|---|
| Lượng truy vấn lớn | Cache Redis: key theo `lat`/`lng` làm tròn 3 chữ số + `radius`, TTL 60s | Chỉ sửa trong `findNearby` |
| Vài nghìn trạm trở lên | PostGIS + GiST (mục 10) | Chỉ sửa trong `findNearby` |
| Cần đo chính xác dưới mét | Đổi sang Haversine hoặc `ST_Distance` | Chỉ sửa công thức |

Điểm chung: **mọi nâng cấp đều nằm gọn trong một hàm service.** Controller, route, hình dạng response không đổi một dòng. Đó là lý do truy vấn được gói vào service thay vì viết thẳng trong controller.
