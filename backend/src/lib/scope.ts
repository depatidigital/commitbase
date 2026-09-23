import { OrgRole, Prisma } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth';
import { prisma } from './prisma';

/** Platform operator (not an org role). Sees and manages everything. */
export function isPlatformAdmin(req: AuthenticatedRequest): boolean {
  return req.user!.role === 'ADMIN' || req.user!.role === 'SUPERADMIN';
}

type Memberships = { organizationId: string; role: OrgRole }[];

/**
 * Organizations the caller belongs to, memoized per request.
 * ponytail: one extra query per request. Move into the JWT only if it shows up in profiling —
 * claims go stale the moment a membership changes, this doesn't.
 */
export async function getMemberships(req: AuthenticatedRequest): Promise<Memberships> {
  const cached = (req as any)._memberships as Memberships | undefined;
  if (cached) return cached;

  const memberships = await prisma.membership.findMany({
    where: { userId: req.user!.userId },
    select: { organizationId: true, role: true },
  });

  (req as any)._memberships = memberships;
  return memberships;
}

export async function getOrgIds(req: AuthenticatedRequest): Promise<string[]> {
  return (await getMemberships(req)).map((m) => m.organizationId);
}

/**
 * The memberships a list shows: the one org the caller switched to
 * (`X-Organization-Id`, the sidebar switch), else all of them. Lists only —
 * permission checks keep using getMemberships, so a link into another of
 * the caller's orgs still opens. A header naming an org they are not in is ignored.
 */
export async function listMemberships(req: AuthenticatedRequest): Promise<Memberships> {
  const memberships = await getMemberships(req);
  const active = req.header('x-organization-id');
  const picked = active ? memberships.filter((m) => m.organizationId === active) : [];
  return picked.length ? picked : memberships;
}

/**
 * Tenant filter for Prisma `where` clauses on org-owned models
 * (Application, Domain). Platform ADMIN gets an empty filter.
 *
 * Usage: `where: { ...(await orgScope(req)) }`
 */
export async function orgScope(
  req: AuthenticatedRequest
): Promise<{ organizationId?: { in: string[] } }> {
  if (isPlatformAdmin(req)) return {};
  return { organizationId: { in: (await listMemberships(req)).map((m) => m.organizationId) } };
}

/** Same filter expressed through a relation, for models that reach an org via `application`. */
export async function orgScopeVia(
  req: AuthenticatedRequest,
  relation: 'application'
): Promise<Record<string, unknown>> {
  if (isPlatformAdmin(req)) return {};
  return { [relation]: { organizationId: { in: (await listMemberships(req)).map((m) => m.organizationId) } } };
}

/**
 * Projects (Source) the caller sees: every project of the orgs they own/admin,
 * and in the rest the ones they made or were added to. Wrapped in AND so a
 * route's own `organizationId`/`OR` keys narrow it instead of replacing it.
 */
export async function projectScope(req: AuthenticatedRequest): Promise<Prisma.SourceWhereInput> {
  if (isPlatformAdmin(req)) return {};
  const memberships = await listMemberships(req);
  const userId = req.user!.userId;
  return {
    AND: [
      { organizationId: { in: memberships.map((m) => m.organizationId) } },
      {
        OR: [
          { organizationId: { in: memberships.filter((m) => m.role !== 'MEMBER').map((m) => m.organizationId) } },
          { createdById: userId },
          { members: { some: { userId } } },
        ],
      },
    ],
  };
}

/** projectScope for Application: an app is visible when its project is. */
export async function appScope(req: AuthenticatedRequest): Promise<Prisma.ApplicationWhereInput> {
  if (isPlatformAdmin(req)) return {};
  return { AND: [{ source: await projectScope(req) }] };
}

/** Delete a project, manage its members: its creator, its org's owners/admins, platform admins. */
export async function canManageProject(
  req: AuthenticatedRequest,
  source: { organizationId: string | null; createdById: string | null }
): Promise<boolean> {
  if (isPlatformAdmin(req)) return true;
  if (!source.organizationId || !(await getOrgRole(req, source.organizationId))) return false;
  return source.createdById === req.user!.userId || (await canManageOrg(req, source.organizationId));
}

/** Role of the caller inside one org, or null when not a member. */
export async function getOrgRole(
  req: AuthenticatedRequest,
  organizationId: string
): Promise<OrgRole | null> {
  const membership = (await getMemberships(req)).find((m) => m.organizationId === organizationId);
  return membership?.role ?? null;
}

/** True when the caller may administer the org (invite, rename, manage members). */
export async function canManageOrg(
  req: AuthenticatedRequest,
  organizationId: string
): Promise<boolean> {
  if (isPlatformAdmin(req)) return true;
  const role = await getOrgRole(req, organizationId);
  return role === 'OWNER' || role === 'ADMIN';
}

/**
 * Logs are written per-user and only sometimes carry an application.
 * A member sees their own log lines plus everything logged against the apps of projects they see.
 */
export async function logScope(req: AuthenticatedRequest): Promise<Record<string, unknown>> {
  if (isPlatformAdmin(req)) return {};
  return {
    OR: [
      { userId: req.user!.userId },
      { application: await appScope(req) },
    ],
  };
}

/**
 * "api.staging.client.com" -> ["api.staging.client.com", "staging.client.com", "client.com"]
 */
export function candidateParents(fqdn: string): string[] {
  const parts = fqdn.toLowerCase().trim().replace(/\.$/, '').split('.');
  return parts.map((_, i) => parts.slice(i).join('.')).filter((d) => d.includes('.'));
}

/**
 * The Domain a hostname sits under, from an already-loaded list — no org
 * check, for background jobs. candidateParents runs longest first, so
 * sub.client.com beats client.com, as in resolveAppHost (lib/appHostname.ts).
 */
export function parentDomainOf<T extends { name: string }>(fqdn: string, domains: T[]): T | null {
  const byName = new Map(domains.map((domain) => [domain.name.toLowerCase(), domain]));
  for (const name of candidateParents(fqdn)) {
    const match = byName.get(name);
    if (match) return match;
  }
  return null;
}
