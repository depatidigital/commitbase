-- AlterTable
ALTER TABLE "applications" ADD COLUMN "diskBytes" BIGINT,
ADD COLUMN "diskMeasuredAt" TIMESTAMP(3);
