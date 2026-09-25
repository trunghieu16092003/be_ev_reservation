const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const { StationStatus, ChargerStatus } = require('../generated/prisma');

const PUBLIC_WHERE = { status: StationStatus.approved, isActive: true }
const countAvailableChargers = {
    _count: { select: { chargers: { where: { status: ChargerStatus.available } } } },
};
const toNum = (v) => (v == null ? null : Number(v));

function serializeCharger(c) {
    return { ...c, pricePerKwh: toNum(c.pricePerKwh) }
}

function serialize(station) {
    const s = {
        ...station,
        latitude: toNum(station.latitude),
        longitude: toNum(station.longitude),
        pricePerKwh: toNum(station.pricePerKwh),
    };

    if (station.chargers) s.chargers = station.chargers.map(serializeCharger);
    if (station._count) {
        s.availableOutlets = station._count.chargers;
        delete s._count;
    }
    return s;
}

async function assertOwner(stationId, userId) {
    const station = await prisma.station.findUnique({
        where: { id: stationId }
    });
    if (!station) throw new AppError('Không tìm thấy trạm', 404);
    if (station.ownerId !== userId) throw new AppError('Bạn không có quyền thao tác trên trạm này', 403);
    return station;
}

async function syncDerivedFields(stationId) {
    const chargers = await prisma.charger.findMany({
        where: { stationId },
        select: { connectorType: true }
    });

    const connectorTypes = [...new Set(chargers.map((c) => c.connectorType).filter(Boolean))];

    return prisma.station.update({
        where: { id: stationId },
        data: { connectorTypes, totalOutlets: chargers.length }
    })
}

function effectivePrice(charger, station) {
    const p = charger.pricePerKwh ?? station.pricePerKwh;
    return toNum(p);
}

async function listPublic({ page = 1, limit = 20, connectorType }) {
    const where = { ...PUBLIC_WHERE };
    if (connectorType) where.connectorTypes = { has: connectorType };

    const [items, total] = await Promise.all([
        prisma.station.findMany({
            where,
            include: countAvailableChargers,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit
        }),
        prisma.station.count({ where })
    ]);
    return { items: items.map(serialize), total, page, limit }
}

async function listMine(ownerId) {
    const items = await prisma.station.findMany({
        where: { ownerId },
        include: countAvailableChargers,
        orderBy: { createdAt: 'desc' },
    });

    return items.map(serialize);
}

async function getPublicById(id, requestId) {
    const station = await prisma.station.findUnique({
        where: { id },
        include: {
            chargers: { orderBy: { outletNumber: 'asc' } },
            ...countAvailableChargers,
        }
    });
    if (!station) throw new AppError('Không tìm thấy trạm', 404);

    const isPublic = station.status === StationStatus.approved && station.isActive;

    if (!isPublic && station.ownerId !== requestId) throw new AppError('Không tìm thấy trạm', 404);

    return serialize(station);
}

async function findNearby({ lat, lng, radiusKm = 5, limit = 20, connectorType }) {
    const dLat = radiusKm / 111;
    const dLng = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
    const ct = connectorType ?? null;

    // Lọc thô bằng bounding box (dùng index idx_stations_lat_lng) rồi mới tính
    // haversine trên tập nhỏ còn lại; bọc subquery vì WHERE không dùng được alias.
    const rows = await prisma.$queryRaw`
        SELECT * FROM (
            SELECT s.id, s.name, s.address, s.phone, s.latitude, s.longitude,
                   s.price_per_kwh   AS "pricePerKwh",
                   s.connector_types AS "connectorTypes",
                   s.total_outlets   AS "totalOutlets",
                   s.opening_hours   AS "openingHours",
                   s.image_urls      AS "imageUrls",
                   (SELECT COUNT(*) FROM chargers c
                     WHERE c.station_id = s.id AND c.status = 'available')::int AS "availableOutlets",
                   (6371 * acos(LEAST(1,
                        cos(radians(${lat})) * cos(radians(s.latitude))
                      * cos(radians(s.longitude) - radians(${lng}))
                      + sin(radians(${lat})) * sin(radians(s.latitude))
                   ))) AS "distanceKm"
            FROM stations s
            WHERE s.status = 'approved'
              AND s.is_active = true
              AND s.latitude  BETWEEN ${lat - dLat} AND ${lat + dLat}
              AND s.longitude BETWEEN ${lng - dLng} AND ${lng + dLng}
              AND (${ct}::text IS NULL OR ${ct}::text = ANY(s.connector_types))
        ) t
        WHERE t."distanceKm" <= ${radiusKm}
        ORDER BY t."distanceKm" ASC
        LIMIT ${limit}
    `;

    return rows.map((r) => ({
        ...serialize(r),
        distanceKm: Math.round(Number(r.distanceKm) * 100) / 100,
    }));
}

module.exports = {
    serialize,
    serializeCharger,
    assertOwner,
    syncDerivedFields,
    effectivePrice,
    listPublic,
    listMine,
    getPublicById,
    findNearby,
};