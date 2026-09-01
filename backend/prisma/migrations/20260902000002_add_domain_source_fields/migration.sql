-- AlterTable
ALTER TABLE "domains" ADD COLUMN     "registrar" TEXT,
ADD COLUMN     "cfZoneId" TEXT,
ADD COLUMN     "lastSyncedAt" TIMESTAMP(3);
