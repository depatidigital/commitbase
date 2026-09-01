-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "runtime" TEXT,
ADD COLUMN     "processName" TEXT,
ADD COLUMN     "rootPath" TEXT,
ADD COLUMN     "configPath" TEXT,
ADD COLUMN     "lastSyncedAt" TIMESTAMP(3);
