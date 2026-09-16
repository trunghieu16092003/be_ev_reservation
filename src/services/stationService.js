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

module.exports = { serialize, serializeCharger, assertOwner, syncDerivedFields, effectivePrice }