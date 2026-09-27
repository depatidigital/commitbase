-- AlterTable
ALTER TABLE "wallets" ADD COLUMN     "arusniagaContactId" TEXT;

-- CreateTable
CREATE TABLE "top_ups" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "invoiceId" TEXT,
    "invoiceRef" TEXT,
    "invoiceUrl" TEXT,
    "invoiceTotal" DOUBLE PRECISION,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3),

    CONSTRAINT "top_ups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "top_ups_invoiceId_key" ON "top_ups"("invoiceId");

-- CreateIndex
CREATE INDEX "top_ups_status_idx" ON "top_ups"("status");

-- CreateIndex
CREATE INDEX "top_ups_organizationId_createdAt_idx" ON "top_ups"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "top_ups" ADD CONSTRAINT "top_ups_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

