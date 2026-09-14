-- Source: where an application's code comes from (repository, branch, clone
-- account, releases), so the apps of one monorepo can share it. Additive only:
-- the old columns on applications stay until every install has backfilled.
-- The backfill below is also run at every backend start (lib/sources.ts), for
-- installs that apply the schema with `prisma db push`.

-- DropForeignKey
ALTER TABLE "releases" DROP CONSTRAINT "releases_applicationId_fkey";

-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "rootDirectory" TEXT,
ADD COLUMN     "sourceId" TEXT;

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "sourceId" TEXT;

-- CreateIndex
CREATE INDEX "deployments_sourceId_idx" ON "deployments"("sourceId");

-- AlterTable
ALTER TABLE "releases" ADD COLUMN     "sourceId" TEXT,
ALTER COLUMN "applicationId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "sources" (
    "id" TEXT NOT NULL,
    "repository" TEXT,
    "branch" TEXT DEFAULT 'main',
    "gitAccountId" TEXT,
    "activeReleaseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sources_gitAccountId_idx" ON "sources"("gitAccountId");

-- CreateIndex
CREATE INDEX "applications_sourceId_idx" ON "applications"("sourceId");

-- CreateIndex
CREATE INDEX "releases_sourceId_idx" ON "releases"("sourceId");

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_gitAccountId_fkey" FOREIGN KEY ("gitAccountId") REFERENCES "git_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_activeReleaseId_fkey" FOREIGN KEY ("activeReleaseId") REFERENCES "releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "releases" ADD CONSTRAINT "releases_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "releases" ADD CONSTRAINT "releases_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: every app gets a source with its own id, so apps/<id>/ — sources,
-- releases, current — is the source's tree without moving a file.
INSERT INTO "sources" ("id", "repository", "branch", "gitAccountId", "activeReleaseId", "createdAt", "updatedAt")
SELECT "id", "repository", "branch", "gitAccountId", "activeReleaseId", "createdAt", CURRENT_TIMESTAMP
FROM "applications" WHERE "sourceId" IS NULL
ON CONFLICT ("id") DO NOTHING;

UPDATE "applications" SET "sourceId" = "id" WHERE "sourceId" IS NULL;

UPDATE "releases" SET "sourceId" = "applicationId" WHERE "sourceId" IS NULL AND "applicationId" IS NOT NULL;

UPDATE "deployments" d SET "sourceId" = a."sourceId"
FROM "applications" a WHERE a."id" = d."applicationId" AND d."sourceId" IS NULL AND a."sourceId" IS NOT NULL;
