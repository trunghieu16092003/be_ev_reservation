// Loại cổng sạc có ở thị trường VN. Dùng chung cho validator (filter GET /stations,
// thêm/sửa charger) và sau này cho car_models — app hiển thị dropdown, không cho gõ tay.
// Type2 = AC (7–22 kW), CCS2 = DC nhanh (30–350 kW), CHAdeMO = DC 50 kW (Nissan Leaf, đang tàn).
// Thêm 'GB/T' nếu có nhu cầu xe Trung Quốc — chỉ cần thêm vào mảng, không đổi schema.
const CONNECTOR_TYPES = ['Type2', 'CCS2', 'CHAdeMO'];

module.exports = { CONNECTOR_TYPES };
