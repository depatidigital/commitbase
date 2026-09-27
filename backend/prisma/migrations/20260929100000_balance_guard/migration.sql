-- AlterTable
ALTER TABLE "applications" ADD COLUMN "stoppedForBalance" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN "balanceNotice" TEXT,
ADD COLUMN "balanceNoticeAt" TIMESTAMP(3),
ADD COLUMN "suspendedAt" TIMESTAMP(3);
