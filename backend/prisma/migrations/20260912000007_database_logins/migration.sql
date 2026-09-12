-- Several logins per organization per database server, each granted access to
-- specific databases, instead of one org-wide login that owns everything.

-- an org may now hold more than one login on a server; a login name is unique per server
DROP INDEX "org_database_accounts_organizationId_databaseServerId_key";
CREATE UNIQUE INDEX "org_database_accounts_databaseServerId_username_key" ON "org_database_accounts"("databaseServerId", "username");
CREATE INDEX "org_database_accounts_organizationId_databaseServerId_idx" ON "org_database_accounts"("organizationId", "databaseServerId");

-- PostgreSQL: the NOLOGIN role that owns a database; null for databases owned by the org login
ALTER TABLE "databases" ADD COLUMN "ownerRole" TEXT;

CREATE TABLE "database_grants" (
    "id" TEXT NOT NULL,
    "databaseId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "database_grants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "database_grants_databaseId_accountId_key" ON "database_grants"("databaseId", "accountId");
CREATE INDEX "database_grants_accountId_idx" ON "database_grants"("accountId");
ALTER TABLE "database_grants" ADD CONSTRAINT "database_grants_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "databases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "database_grants" ADD CONSTRAINT "database_grants_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "org_database_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- what is true on the servers today: every database the panel made is reached by its org's login
INSERT INTO "database_grants" ("id", "databaseId", "accountId")
SELECT gen_random_uuid()::text, d."id", a."id"
FROM "databases" d
JOIN "org_database_accounts" a ON a."organizationId" = d."organizationId" AND a."databaseServerId" = d."databaseServerId"
WHERE d."discovered" = false;
