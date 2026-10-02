-- per-workspace RAM cap; null keeps the ORG_MEMORY_MAX default
ALTER TABLE "organizations" ADD COLUMN "memoryMax" TEXT;
