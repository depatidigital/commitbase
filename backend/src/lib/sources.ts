import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

/**
 * Sources: where an application's code comes from (schema.prisma, model Source).
 *
 * Apps from before sources existed get one here, with the app's own id — so
 * apps/<id>/ is already the source's tree and no file moves — copied from the
 * columns the app used to carry. Idempotent, and run at every start: upgrades
 * apply the schema with `prisma db push`, which has no data step.
 */
export async function backfillSources(): Promise<number> {
  const [created] = await prisma.$transaction([
    prisma.$executeRaw`
      INSERT INTO "sources" ("id", "repository", "branch", "gitAccountId", "activeReleaseId", "createdAt", "updatedAt")
      SELECT "id", "repository", "branch", "gitAccountId", "activeReleaseId", "createdAt", CURRENT_TIMESTAMP
      FROM "applications" WHERE "sourceId" IS NULL
      ON CONFLICT ("id") DO NOTHING`,
    prisma.$executeRaw`UPDATE "applications" SET "sourceId" = "id" WHERE "sourceId" IS NULL`,
    prisma.$executeRaw`UPDATE "releases" SET "sourceId" = "applicationId" WHERE "sourceId" IS NULL AND "applicationId" IS NOT NULL`,
    prisma.$executeRaw`
      UPDATE "deployments" d SET "sourceId" = a."sourceId"
      FROM "applications" a WHERE a."id" = d."applicationId" AND d."sourceId" IS NULL AND a."sourceId" IS NOT NULL`,
  ]);
  return created;
}

/**
 * Sources no application uses any more; their releases go with them (cascade).
 * Called wherever apps are deleted — including by an organization's cascade.
 */
export const dropOrphanSources = () => prisma.source.deleteMany({ where: { applications: { none: {} } } });

export type SourceFields = { repository?: string | null; branch?: string | null; gitAccountId?: string | null };

/** A new app on a new source of its own, sharing its id — see model Source. */
export function createApplicationWithSource(
  data: Omit<Prisma.ApplicationUncheckedCreateInput, 'id' | 'sourceId'>,
  source: SourceFields,
) {
  return prisma.$transaction(async (tx) => {
    const { id } = await tx.source.create({ data: source });
    return tx.application.create({ data: { ...data, id, sourceId: id }, include: { source: true } });
  });
}

type WithSource = { source?: { repository: string | null; branch: string | null; gitAccountId: string | null; activeReleaseId: string | null } | null };

/**
 * The app as the API has always answered it: repository, branch, clone account
 * and live release read from its source — never the deprecated columns left on
 * the row, which stopped being written.
 */
export function withSourceFields<T extends WithSource>(app: T) {
  return {
    ...app,
    repository: app.source?.repository ?? null,
    branch: app.source?.branch ?? null,
    gitAccountId: app.source?.gitAccountId ?? null,
    activeReleaseId: app.source?.activeReleaseId ?? null,
  };
}
