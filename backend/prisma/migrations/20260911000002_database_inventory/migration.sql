-- Inventory sync: databases found on a server, and a mirror of its logins.
-- A database no longer needs an application — it belongs to its organization.
-- AlterTable
ALTER TABLE "databases" ADD COLUMN     "discovered" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sizeBytes" DOUBLE PRECISION,
ALTER COLUMN "applicationId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "database_users" (
    "id" TEXT NOT NULL,
    "databaseServerId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "host" TEXT NOT NULL DEFAULT '',
    "canLogin" BOOLEAN NOT NULL DEFAULT true,
    "superuser" BOOLEAN NOT NULL DEFAULT false,
    "databases" TEXT[],
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "database_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "database_users_databaseServerId_username_host_key" ON "database_users"("databaseServerId", "username", "host");

-- CreateIndex
CREATE UNIQUE INDEX "databases_databaseServerId_dbName_key" ON "databases"("databaseServerId", "dbName");

-- AddForeignKey
ALTER TABLE "database_users" ADD CONSTRAINT "database_users_databaseServerId_fkey" FOREIGN KEY ("databaseServerId") REFERENCES "database_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

