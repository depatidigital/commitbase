import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { parentDomainOf } from './scope';

/**
 * An application's hostnames (schema.prisma, model AppDomain): one or more,
 * all alike — none is its "main" one. What works on one name (its DNS record,
 * its Caddy route, a reachability check) takes an `AppAt`: the app at that name.
 */

/** An app at one of its hostnames. `id` is the app's; `domain` the hostname; `domainId` its zone. */
export type AppAt = { id: string; domain: string; domainId: string | null };

/** An app's hostnames, in the one order they are ever listed (API responses too). */
export const withDomains = {
  domains: {
    select: { host: true, domainId: true, parentDomain: { select: { id: true, name: true, expiresAt: true, shared: true } } },
    orderBy: { host: 'asc' },
  },
} as const satisfies Prisma.ApplicationInclude;

type WithHosts = { id: string; domains: Array<{ host: string; domainId: string | null }> };

export const hostsOf = (app: { domains: Array<{ host: string }> }): string[] => app.domains.map((d) => d.host);

/** The app at each of its names. */
export const atEach = (app: WithHosts): AppAt[] => app.domains.map((d) => ({ id: app.id, domain: d.host, domainId: d.domainId }));

/** The names for a log line or a message: `a.com, b.com`. */
export const hostList = (app: { domains: Array<{ host: string }> }): string => hostsOf(app).join(', ');

/** An app's hostnames, by its id — for code that holds the app without them. */
export async function appHosts(applicationId: string): Promise<string[]> {
  const rows = await prisma.appDomain.findMany({ where: { applicationId }, select: { host: true }, orderBy: { host: 'asc' } });
  return rows.map((row) => row.host);
}

/** The app answering on a hostname, if any. */
export async function appIdAt(host: string): Promise<string | null> {
  const row = await prisma.appDomain.findUnique({ where: { host }, select: { applicationId: true } });
  return row?.applicationId ?? null;
}

/** The zone each name sits under, from the Domains the platform knows. */
export async function zonesFor(hosts: string[]): Promise<Array<{ host: string; domainId: string | null }>> {
  const zones = await prisma.domain.findMany({ select: { id: true, name: true } });
  return hosts.map((host) => ({ host, domainId: parentDomainOf(host, zones)?.id ?? null }));
}

/**
 * Make these the app's names: the ones it no longer has go, new ones come
 * with their zone. A name another app holds is not taken from it — the
 * caller checks first; here it fails on the unique host.
 */
export async function setAppHosts(
  applicationId: string,
  hosts: Array<string | { host: string; domainId: string | null }>,
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  const wanted = hosts.map((h) => (typeof h === 'string' ? h : h.host));
  await tx.appDomain.deleteMany({ where: { applicationId, host: { notIn: wanted } } });
  const have = new Set((await tx.appDomain.findMany({ where: { applicationId }, select: { host: true } })).map((d) => d.host));
  const known = hosts.filter((h): h is { host: string; domainId: string | null } => typeof h !== 'string');
  const unknown = await zonesFor(hosts.filter((h): h is string => typeof h === 'string'));
  const all = [...known, ...unknown];
  const fresh = all.filter((h) => !have.has(h.host));
  if (fresh.length) {
    await tx.appDomain.createMany({ data: fresh.map((h) => ({ applicationId, host: h.host, domainId: h.domainId })) });
  }
  // a name from before its zone was known gets it now; a set one never moves
  for (const h of all.filter((h) => have.has(h.host) && h.domainId)) {
    await tx.appDomain.updateMany({ where: { applicationId, host: h.host, domainId: null }, data: { domainId: h.domainId } });
  }
}

/**
 * Apps from before AppDomain carry their one hostname in `domain` (and its
 * zone in `domainId`): copied here, then cleared so nothing reads it by
 * mistake. Idempotent, run at every start — `prisma db push` has no data step.
 */
export async function backfillAppDomains(): Promise<number> {
  const [created] = await prisma.$transaction([
    prisma.$executeRaw`
      INSERT INTO "app_domains" ("id", "host", "applicationId", "domainId", "createdAt")
      SELECT 'ad_' || "id", "domain", "id", "domainId", "createdAt"
      FROM "applications" WHERE "domain" IS NOT NULL
      ON CONFLICT ("host") DO NOTHING`,
    prisma.$executeRaw`UPDATE "applications" SET "domain" = NULL, "domainId" = NULL WHERE "domain" IS NOT NULL`,
  ]);
  return created;
}
