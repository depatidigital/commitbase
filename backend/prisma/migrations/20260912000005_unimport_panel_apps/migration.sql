-- The inventory sync used to stamp its runtime (and a guessed directory) onto
-- apps the panel itself deploys, which then refused deploys as "imported" and
-- dropped out of route re-application. An app with panel deployments is the
-- panel's: clear what the sync wrote over it.
UPDATE "applications"
SET "runtime" = NULL, "processName" = NULL, "rootPath" = NULL, "configPath" = NULL, "lastSyncedAt" = NULL
WHERE "runtime" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "deployments" d WHERE d."applicationId" = "applications"."id");
