-- CreateEnum
CREATE TYPE "OrgProvisionState" AS ENUM ('NONE', 'QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN "provisionState" "OrgProvisionState" NOT NULL DEFAULT 'NONE',
ADD COLUMN "provisionError" TEXT,
ADD COLUMN "provisionJob" JSONB,
ADD COLUMN "provisionedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "organizations_provisionState_idx" ON "organizations"("provisionState");
