-- Which node an application was discovered on. Deploys still follow the
-- organization's placement; this records where the running site actually lives.
ALTER TABLE "applications" ADD COLUMN "serverId" TEXT;

-- CreateIndex
CREATE INDEX "applications_serverId_idx" ON "applications"("serverId");

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
