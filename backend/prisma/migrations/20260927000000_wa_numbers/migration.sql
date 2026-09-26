-- CreateTable
CREATE TABLE "wa_numbers" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wa_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wa_numbers_instanceId_key" ON "wa_numbers"("instanceId");

-- CreateIndex
CREATE INDEX "wa_numbers_organizationId_idx" ON "wa_numbers"("organizationId");

-- AddForeignKey
ALTER TABLE "wa_numbers" ADD CONSTRAINT "wa_numbers_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
