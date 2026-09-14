-- An app switched off in the panel: kept, not monitored, listed last
ALTER TABLE "applications" ADD COLUMN "disabled" BOOLEAN NOT NULL DEFAULT false;
