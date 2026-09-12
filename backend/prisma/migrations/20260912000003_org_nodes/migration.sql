-- Organizations are no longer pinned to one node. Each app carries its own
-- serverId; an org is provisioned on every node it uses (org_nodes). Every
-- step copies before it drops, so no placement or provisioning state is lost.

-- CreateTable
CREATE TABLE "org_nodes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "state" "ProvisionState" NOT NULL DEFAULT 'NONE',
    "error" TEXT,
    "log" TEXT,
    "job" JSONB,
    "provisionedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_nodes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "org_nodes_state_idx" ON "org_nodes"("state");
CREATE UNIQUE INDEX "org_nodes_organizationId_serverId_key" ON "org_nodes"("organizationId", "serverId");
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The old one-node placement becomes the org's first node, with its state.
INSERT INTO "org_nodes" ("id", "organizationId", "serverId", "state", "error", "log", "job", "provisionedAt", "updatedAt")
SELECT 'on_' || "id", "id", "serverId", "provisionState", "provisionError", "provisionLog", "provisionJob", "provisionedAt", CURRENT_TIMESTAMP
FROM "organizations"
WHERE "serverId" IS NOT NULL;

-- Apps followed their org's placement implicitly; make it explicit on the app.
UPDATE "applications" AS a
SET "serverId" = o."serverId"
FROM "organizations" AS o
WHERE a."organizationId" = o."id" AND a."serverId" IS NULL AND o."serverId" IS NOT NULL;

-- One UID per org, the same on every node. Filled on first provisioning.
ALTER TABLE "organizations" ADD COLUMN "uid" INTEGER;
CREATE UNIQUE INDEX "organizations_uid_key" ON "organizations"("uid");

-- Provisioning state now lives on org_nodes (copied above).
DROP INDEX "organizations_provisionState_idx";
ALTER TABLE "organizations"
    DROP COLUMN "provisionState",
    DROP COLUMN "provisionError",
    DROP COLUMN "provisionLog",
    DROP COLUMN "provisionJob",
    DROP COLUMN "provisionedAt";
