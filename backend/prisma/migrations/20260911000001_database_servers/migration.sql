-- Database servers: Postgres/MySQL instances tenant databases are created on,
-- the org's login on each, and per-engine placement of an organization.
-- CreateEnum
CREATE TYPE "DbServerMode" AS ENUM ('TUNNEL', 'DIRECT');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "mysqlServerId" TEXT,
ADD COLUMN     "postgresServerId" TEXT;

-- AlterTable
ALTER TABLE "databases" ADD COLUMN     "databaseServerId" TEXT,
ADD COLUMN     "dbName" TEXT,
ADD COLUMN     "organizationId" TEXT;

-- CreateTable
CREATE TABLE "database_servers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "engine" "DatabaseType" NOT NULL,
    "mode" "DbServerMode" NOT NULL DEFAULT 'TUNNEL',
    "serverId" TEXT,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "tlsMode" TEXT NOT NULL DEFAULT 'REQUIRE',
    "caCert" TEXT,
    "adminUser" TEXT NOT NULL,
    "adminPasswordEnc" TEXT NOT NULL,
    "appHost" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "version" TEXT,
    "adminRights" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "database_servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_database_accounts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "databaseServerId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "org_database_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "database_servers_serverId_idx" ON "database_servers"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "org_database_accounts_organizationId_databaseServerId_key" ON "org_database_accounts"("organizationId", "databaseServerId");

-- CreateIndex
CREATE INDEX "databases_organizationId_idx" ON "databases"("organizationId");

-- CreateIndex
CREATE INDEX "databases_databaseServerId_idx" ON "databases"("databaseServerId");

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_postgresServerId_fkey" FOREIGN KEY ("postgresServerId") REFERENCES "database_servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_mysqlServerId_fkey" FOREIGN KEY ("mysqlServerId") REFERENCES "database_servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_servers" ADD CONSTRAINT "database_servers_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_database_accounts" ADD CONSTRAINT "org_database_accounts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_database_accounts" ADD CONSTRAINT "org_database_accounts_databaseServerId_fkey" FOREIGN KEY ("databaseServerId") REFERENCES "database_servers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "databases" ADD CONSTRAINT "databases_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "databases" ADD CONSTRAINT "databases_databaseServerId_fkey" FOREIGN KEY ("databaseServerId") REFERENCES "database_servers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Backfill: a database belongs to its application's organization.
UPDATE "databases" d SET "organizationId" = a."organizationId"
FROM "applications" a WHERE d."applicationId" = a."id" AND d."organizationId" IS NULL;
