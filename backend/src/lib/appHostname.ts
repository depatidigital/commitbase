import type { Domain } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth';
import { prisma } from './prisma';
import { candidateParents, getOrgIds, isPlatformAdmin, orgScope } from './scope';
import { listCloudflareDnsRecords } from '../services/cloudflareService';
import { listCaddyRouteHosts } from '../services/caddyService';

/**
 * Where an app's hostname may live, and which organization the app then
 * belongs to. Two kinds of parent:
 *
 * - a domain one of the caller's orgs owns: the app belongs to that org;
 * - a shared platform domain (`Domain.shared`): any org may put an app under
 *   it, one label deep, and the app belongs to the caller's org.
 */

type Resolved = { parent: Domain; organizationId: string | null };
type Refused = { status: number; error: string };

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const normalizeHost = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/\.$/, '');

/**
 * `wantedOrgId`: the org the app should belong to under a shared domain —
 * the caller's pick on create, the app's own org on a rename. Without one, a
 * caller in exactly one org gets that org.
 */
export async function resolveAppHost(
  req: AuthenticatedRequest,
  host: string,
  wantedOrgId?: string | null,
): Promise<Resolved | Refused> {
  const names = candidateParents(host);
  if (!names.length || !host.split('.').every((label) => LABEL.test(label))) {
    return { status: 400, error: `${host} is not a valid hostname` };
  }

  const matches = await prisma.domain.findMany({
    where: { name: { in: names }, OR: [await orgScope(req), { shared: true }] },
  });
  // longest match wins: sub.client.com beats client.com
  const parent = matches.sort((a, b) => b.name.length - a.name.length)[0];
  if (!parent) {
    return {
      status: 403,
      error: 'Domain is not assigned to your organization. Ask an administrator to assign it first.',
    };
  }

  if (!parent.shared) return { parent, organizationId: parent.organizationId };

  // one label under a shared domain — never its apex, never a deeper tree
  const label = host.slice(0, -(parent.name.length + 1));
  if (host === parent.name || !LABEL.test(label)) {
    return { status: 400, error: `Pick one name under ${parent.name}, like shop.${parent.name}` };
  }

  const orgIds = await getOrgIds(req);
  const organizationId = wantedOrgId ?? (orgIds.length === 1 ? orgIds[0]! : null);
  if (!organizationId) {
    return { status: 400, error: 'Pick the organization this app belongs to' };
  }
  if (!isPlatformAdmin(req) && !orgIds.includes(organizationId)) {
    return { status: 403, error: 'You are not a member of that organization' };
  }

  return { parent, organizationId };
}

/**
 * A new name under a shared domain must not already mean something: every
 * org can claim names there, so a name with its own DNS record, or one Caddy
 * already routes on the node (the panel itself, via the wildcard), would be a
 * takeover. Owned domains skip this — their org decides what lives there.
 */
export async function sharedHostTaken(
  parent: Domain,
  host: string,
  node: Parameters<typeof listCaddyRouteHosts>[0],
): Promise<string | null> {
  if (!parent.shared) return null;

  // another app on the same name is the caller's unique check, not this
  const taken = `${host} is already taken — pick another name`;
  const records = parent.cfZoneId ? await listCloudflareDnsRecords(parent.cfZoneId) : null;
  const hosts = await listCaddyRouteHosts(node).catch(() => null);
  if (!records || !hosts) return `Could not check whether ${host} is free — try again`;

  if (records.some((record: any) => normalizeHost(record?.name) === host)) return taken;
  if (hosts.some((name) => normalizeHost(name) === host)) return taken;
  return null;
}

/** Overwriting a conflicting DNS record is an admin's call under a shared domain. */
export async function mayForceDns(req: AuthenticatedRequest, domainId: string | null): Promise<boolean> {
  if (isPlatformAdmin(req) || !domainId) return true;
  const parent = await prisma.domain.findUnique({ where: { id: domainId }, select: { shared: true } });
  return !parent?.shared;
}
