-- How an imported site split by path is served ([{ path, proxy?, root? }]),
-- so the static half beside a proxied /api is shown. Filled by the sync.
ALTER TABLE "applications" ADD COLUMN "routing" JSONB;
