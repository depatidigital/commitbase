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
    // owner and node from its apps, for sources from before they carried them
    prisma.$executeRaw`
      UPDATE "sources" s SET "organizationId" = a."organizationId"
      FROM "applications" a WHERE a."sourceId" = s."id" AND s."organizationId" IS NULL AND a."organizationId" IS NOT NULL`,
    prisma.$executeRaw`
      UPDATE "sources" s SET "serverId" = a."serverId"
      FROM "applications" a WHERE a."sourceId" = s."id" AND s."serverId" IS NULL AND a."serverId" IS NOT NULL`,
  ]);
  return created;
}

/**
 * Sources no application uses any more; their releases go with them (cascade).
 * Called wherever apps are deleted — including by an organization's cascade.
 */
export const dropOrphanSources = () => prisma.source.deleteMany({ where: { applications: { none: {} } } });

export type SourceFields = {
  /** what the UI calls it; null = derived (lib/sources sourceName) */
  name?: string | null;
  repository?: string | null;
  branch?: string | null;
  gitAccountId?: string | null;
  path?: string | null;
};

/**
 * A new app on a new source of its own, sharing its id — see model Source. The
 * source takes the app's owner and node: apps follow their source's.
 */
export function createApplicationWithSource(
  data: Omit<Prisma.ApplicationUncheckedCreateInput, 'id' | 'sourceId'>,
  source: SourceFields,
) {
  return prisma.$transaction(async (tx) => {
    const { id } = await tx.source.create({
      data: { ...source, organizationId: data.organizationId ?? null, serverId: data.serverId ?? null },
    });
    return tx.application.create({ data: { ...data, id, sourceId: id }, include: { source: true } });
  });
}

/**
 * Give a source an owner — and every app of it, since apps follow their source.
 * The one way an org is assigned; `applications.organizationId` stays as the
 * copy every per-app scope check already reads.
 */
export async function setSourceOrganization(sourceIds: string[], organizationId: string | null): Promise<number> {
  const [, apps] = await prisma.$transaction([
    prisma.source.updateMany({ where: { id: { in: sourceIds } }, data: { organizationId } }),
    prisma.application.updateMany({ where: { sourceId: { in: sourceIds } }, data: { organizationId } }),
  ]);
  return apps.count;
}

/** `https://gitlab.com/acme/shop.git` → `shop`; `/var/www/html/shop/` → `shop`. Pure. */
const lastSegment = (value: string) => value.replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).pop() || null;

// what a served folder is usually called inside its project — no name at all
const GENERIC = new Set(['public', 'public_html', 'html', 'www', 'htdocs', 'web', 'dist', 'build', 'out', 'current', 'server', 'app', 'src']);

/** `/var/www/html/cgc.depatidigital.com/public` → `cgc.depatidigital.com`: the nearest folder with a name of its own. */
const folderName = (value: string) =>
  value.replace(/\/+$/, '').split('/').filter(Boolean).reverse().find((part) => !GENERIC.has(part.toLowerCase())) ?? lastSegment(value);

/**
 * What a source is called when nobody named it: the folder it is checked out
 * in — one repository is often checked out several times on a server, once
 * per site, and the folder is what tells those apart — else its repository,
 * else its first app's hostname. Pure.
 */
export function sourceName(
  source: { name: string | null; repository: string | null; path: string | null },
  firstDomain?: string | null,
): string {
  return (
    source.name?.trim() ||
    (source.path && folderName(source.path)) ||
    (source.repository && lastSegment(source.repository)) ||
    firstDomain ||
    'Proyek'
  );
}

type WithSource = { source?: { repository: string | null; branch: string | null; gitAccountId: string | null; activeReleaseId: string | null; path?: string | null } | null };

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
    // an imported one: the git checkout its folder sits in (git rev-parse --show-toplevel, by the sync)
    checkoutPath: app.source?.path ?? null,
  };
}

/** A branch name git takes as a name, never as an option or a revision expression. Pure. */
export const isBranchName = (name: string) =>
  /^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith('-') && !name.includes('..') && !name.endsWith('/') && !name.endsWith('.lock');
