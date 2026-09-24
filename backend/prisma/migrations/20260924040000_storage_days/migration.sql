-- CreateTable
CREATE TABLE "storage_days" (
    "organizationId" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "diskBytes" BIGINT NOT NULL DEFAULT 0,
    "journalBytes" BIGINT NOT NULL DEFAULT 0,
    "objectBytes" BIGINT NOT NULL DEFAULT 0,
    "backfilled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "storage_days_pkey" PRIMARY KEY ("organizationId","day")
);

-- AddForeignKey
ALTER TABLE "storage_days" ADD CONSTRAINT "storage_days_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
