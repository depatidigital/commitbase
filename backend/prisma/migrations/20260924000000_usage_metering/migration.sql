-- AlterTable
ALTER TABLE "org_nodes" ADD COLUMN "meterCpuUsec" BIGINT,
ADD COLUMN "meterAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "usage_hours" (
    "organizationId" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "cpuSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "memGbSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "storageGbSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "usage_hours_pkey" PRIMARY KEY ("organizationId","hour")
);

-- AddForeignKey
ALTER TABLE "usage_hours" ADD CONSTRAINT "usage_hours_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
