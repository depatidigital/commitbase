-- CreateTable
CREATE TABLE "caddy_snapshots" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "hosts" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "caddy_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "caddy_snapshots_serverId_createdAt_idx" ON "caddy_snapshots"("serverId", "createdAt");
