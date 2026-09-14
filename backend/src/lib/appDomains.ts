import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { parentDomainOf } from './scope';

/**
 * Where an application answers (schema.prisma, model AppDomain): hostnames, or
 * hostnames and a path under them — one or more, all alike, none its "main".
 * A hostname can be shared by several apps, one per path; all of them belong
 * to one organization. What works on one name (its DNS record, a reachability
 * check) takes an `AppAt`: the app at that name. DNS is per hostname, whatever
 * paths it is split into.
 */

/** An app at one of its hostnames. `id` is the app's; `domain` the hostname; `domainId` its zone. */
export type AppAt = { id: string; domain: string; domainId: string | null };

/** An app's hostnames, in the one order they are ever listed (API responses too). */
export const withDomains = {
  domains: {
    select: {
      host: true,
      path: true,
      stripPrefix: true,
      domainId: true,
      parentDomain: { select: { id: true, name: true, expiresAt: true, shared: true } },
    },
    orderBy: [{ host: 'asc' }, { path: 'asc' }],
  },
} as const satisfies Prisma.ApplicationInclude;

type WithHosts = { id: string; domains: Array<{ host: string; domainId: string | null }> };

/** Its hostnames, each once — an app bound to two paths of one name has that name once. */
export const hostsOf = (app: { domains: Array<{ host: string }> }): string[] => [...new Set(app.domains.map((d) => d.host))];

/** `app.example.com` or `app.example.com/api/*` — a binding as a person reads it. Pure. */
export const bindingLabel = (d: { host: string; path?: string | null }) => `${d.host}${d.path ?? ''}`;

/** The app at each of its names — once per hostname, whatever its paths. */
export const atEach = (app: WithHosts): AppAt[] => {
  const seen = new Map<string, AppAt>();
  for (const d of app.domains) if (!seen.has(d.host)) seen.set(d.host, { id: app.id, domain: d.host, domainId: d.domainId });
  return [...seen.values()];
};

/** The names for a log line or a message: `a.com, b.com`. */
export const hostList = (app: { domains: Array<{ host: string }> }): string => hostsOf(app).join(', ');

/** An app's hostnames, by its id — for code that holds the app without them. */
export async function appHosts(applicationId: string): Promise<string[]> {
  const rows = await prisma.appDomain.findMany({ where: { applicationId }, select: { host: true }, distinct: ['host'], orderBy: { host: 'asc' } });
  return rows.map((row) => row.host);
}

/** The app bound to exactly this hostname and path ("" = the whole name), if any. */
export async function appIdAt(host: string, path = ''): Promise<string | null> {
  const row = await prisma.appDomain.findUnique({ where: { host_path: { host, path } }, select: { applicationId: true } });
  return row?.applicationId ?? null;
}

/**
 * Whose a hostname is: the organization of the apps already bound to it (one,
 * by the rule), `null` for apps nobody has been given yet, `undefined` when no
 * app is bound to it at all. A path on someone else's name is never allowed.
 */
export async function hostOwner(host: string): Promise<string | null | undefined> {
  const row = await prisma.appDomain.findFirst({ where: { host }, select: { application: { select: { organizationId: true } } } });
  return row ? row.application.organizationId : undefined;
}

/** Why `organizationId` may not bind to `host`, or null when it may. */
export async function hostRefused(host: string, organizationId: string | null): Promise<string | null> {
  const owner = await hostOwner(host);
  if (owner === undefined || owner === organizationId) return null;
  return `${host} is used by another organization's app — a hostname and its paths belong to one organization`;
}

/** The zone each name sits under, from the Domains the platform knows. */
export async function zonesFor(hosts: string[]): Promise<Array<{ host: string; domainId: string | null }>> {
  const zones = await prisma.domain.findMany({ select: { id: true, name: true } });
  return hosts.map((host) => ({ host, domainId: parentDomainOf(host, zones)?.id ?? null }));
}

/**
 * Make these the app's whole-name bindings: the ones it no longer has go, new ones come
 * with their zone. A name another app holds is not taken from it — the
 * caller checks first; here it fails on the unique host.
 */
export async function setAppHosts(
  applicationId: string,
  hosts: Array<string | { host: string; domainId: string | null }>,
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  // the whole-name bindings only: its paths are managed on their own
  const wanted = hosts.map((h) => (typeof h === 'string' ? h : h.host));
  await tx.appDomain.deleteMany({ where: { applicationId, path: '', host: { notIn: wanted } } });
  const have = new Set((await tx.appDomain.findMany({ where: { applicationId, path: '' }, select: { host: true } })).map((d) => d.host));
  const known = hosts.filter((h): h is { host: string; domainId: string | null } => typeof h !== 'string');
  const unknown = await zonesFor(hosts.filter((h): h is string => typeof h === 'string'));
  const all = [...known, ...unknown];
  const fresh = all.filter((h) => !have.has(h.host));
  if (fresh.length) {
    await tx.appDomain.createMany({ data: fresh.map((h) => ({ applicationId, host: h.host, path: '', domainId: h.domainId })) });
  }
  // a name from before its zone was known gets it now; a set one never moves
  for (const h of all.filter((h) => have.has(h.host) && h.domainId)) {
    await tx.appDomain.updateMany({ where: { applicationId, host: h.host, path: '', domainId: null }, data: { domainId: h.domainId } });
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
      INSERT INTO "app_domains" ("id", "host", "path", "applicationId", "domainId", "createdAt")
      SELECT 'ad_' || "id", "domain", '', "id", "domainId", "createdAt"
      FROM "applications" WHERE "domain" IS NOT NULL
      ON CONFLICT ("host", "path") DO NOTHING`,
    prisma.$executeRaw`UPDATE "applications" SET "domain" = NULL, "domainId" = NULL WHERE "domain" IS NOT NULL`,
  ]);
  return created;
}
