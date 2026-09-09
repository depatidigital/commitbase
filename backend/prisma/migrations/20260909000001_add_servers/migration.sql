-- CreateTable
CREATE TABLE "servers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "sshUser" TEXT NOT NULL DEFAULT 'commitbase',
    "sshPort" INTEGER NOT NULL DEFAULT 22,
    "sshKeyPath" TEXT NOT NULL,
    "publicIp" TEXT NOT NULL,
    "caddyApiUrl" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "lastSeenAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "servers_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN "serverId" TEXT;

-- CreateIndex
CREATE INDEX "organizations_serverId_idx" ON "organizations"("serverId");

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
