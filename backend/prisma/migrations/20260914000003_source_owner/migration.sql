-- A source (a "Proyek" in the UI) carries its name, owner and node, and for
-- apps imported from a server the checkout they are served from. Additive; the
-- owner and node are filled from its apps by lib/sources backfillSources too.

-- AlterTable
ALTER TABLE "sources" ADD COLUMN     "name" TEXT,
ADD COLUMN     "organizationId" TEXT,
ADD COLUMN     "path" TEXT,
ADD COLUMN     "serverId" TEXT;

-- CreateIndex
CREATE INDEX "sources_organizationId_idx" ON "sources"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "sources_serverId_path_key" ON "sources"("serverId", "path");

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "sources" s SET "organizationId" = a."organizationId"
FROM "applications" a WHERE a."sourceId" = s."id" AND s."organizationId" IS NULL AND a."organizationId" IS NOT NULL;

UPDATE "sources" s SET "serverId" = a."serverId"
FROM "applications" a WHERE a."sourceId" = s."id" AND s."serverId" IS NULL AND a."serverId" IS NOT NULL;
