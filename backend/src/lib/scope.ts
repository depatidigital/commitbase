import { OrgRole } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth';
import { prisma } from './prisma';

/** Platform operator (not an org role). Sees and manages everything. */
export function isPlatformAdmin(req: AuthenticatedRequest): boolean {
  return req.user!.role === 'ADMIN';
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
 * Tenant filter for Prisma `where` clauses on org-owned models
 * (Application, Domain). Platform ADMIN gets an empty filter.
 *
 * Usage: `where: { ...(await orgScope(req)) }`
 */
export async function orgScope(
  req: AuthenticatedRequest
): Promise<{ organizationId?: { in: string[] } }> {
  if (isPlatformAdmin(req)) return {};
  return { organizationId: { in: await getOrgIds(req) } };
}

/** Same filter expressed through a relation, for models that reach an org via `application`. */
export async function orgScopeVia(
  req: AuthenticatedRequest,
  relation: 'application'
): Promise<Record<string, unknown>> {
  if (isPlatformAdmin(req)) return {};
  return { [relation]: { organizationId: { in: await getOrgIds(req) } } };
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
 * A member sees their own log lines plus everything logged against their orgs' apps.
 */
export async function logScope(req: AuthenticatedRequest): Promise<Record<string, unknown>> {
  if (isPlatformAdmin(req)) return {};
  const orgIds = await getOrgIds(req);
  return {
    OR: [
      { userId: req.user!.userId },
      { application: { organizationId: { in: orgIds } } },
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
 * Resolve the Domain row that `fqdn` must live under, enforcing that the caller's
 * organization owns it. Returns null when the caller may not use this hostname.
 */
export async function resolveOwnedDomain(req: AuthenticatedRequest, fqdn: string) {
  const names = candidateParents(fqdn);
  if (names.length === 0) return null;

  const matches = await prisma.domain.findMany({
    where: {
      ...(await orgScope(req)),
      name: { in: names },
    },
  });

  // longest match wins: sub.client.com beats client.com
  return matches.sort((a, b) => b.name.length - a.name.length)[0] ?? null;
}
