-- CreateEnum
CREATE TYPE "ProvisionState" AS ENUM ('NONE', 'QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN "provisionState" "ProvisionState" NOT NULL DEFAULT 'NONE',
ADD COLUMN "provisionError" TEXT,
ADD COLUMN "provisionJob" JSONB,
ADD COLUMN "provisionedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "servers" ADD COLUMN "setupState" "ProvisionState" NOT NULL DEFAULT 'NONE',
ADD COLUMN "setupError" TEXT,
ADD COLUMN "setupJob" JSONB,
ADD COLUMN "setupLog" TEXT,
ADD COLUMN "setupAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "organizations_provisionState_idx" ON "organizations"("provisionState");
