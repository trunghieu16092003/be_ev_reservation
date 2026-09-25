/*
  Warnings:

  - A unique constraint covering the columns `[station_id,outlet_number]` on the table `chargers` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "station_status" AS ENUM ('draft', 'pending', 'approved', 'rejected', 'suspended');

-- AlterTable
ALTER TABLE "chargers" ADD COLUMN     "price_per_kwh" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "stations" ADD COLUMN     "image_urls" VARCHAR[] DEFAULT ARRAY[]::VARCHAR[],
ADD COLUMN     "rejected_reason" VARCHAR,
ADD COLUMN     "status" "station_status" NOT NULL DEFAULT 'draft',
ALTER COLUMN "price_per_kwh" SET DATA TYPE DECIMAL(10,2);

-- CreateIndex
CREATE INDEX "idx_chargers_station_id" ON "chargers"("station_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_chargers_station_outlet" ON "chargers"("station_id", "outlet_number");

-- CreateIndex
CREATE INDEX "idx_stations_owner_id" ON "stations"("owner_id");

-- CreateIndex
CREATE INDEX "idx_stations_lat_lng" ON "stations"("latitude", "longitude");

-- CreateIndex
CREATE INDEX "idx_stations_status_active" ON "stations"("status", "is_active");
