import type { Application, Domain } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth';
import { prisma } from './prisma';
import { canManageOrg, candidateParents, getOrgIds, isPlatformAdmin, orgScope } from './scope';
import { serverForApplication } from './servers';
import { findCloudflareZone, getDefaultDnsTarget, listCloudflareDnsRecords } from '../services/cloudflareService';
import { listCaddyRouteHosts } from '../services/caddyService';
import { ensureAppHostname, type HostnameOutcome } from '../services/appDnsService';
import { linkExistingCloudflareZone, moveDomainToCloudflare } from '../services/domainCloudflareService';

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

type DnsTarget = { type: 'A' | 'CNAME'; content: string };

export type HostInspection = {
  /** another app already has this hostname; name only when the caller may see that app */
  usedBy: { id: string; name: string } | { id: null; name: null } | null;
  /** the bare domain — usually the main website */
  apex: boolean;
  /**
   * Who answers DNS for the domain: a Cloudflare zone we can edit (linked, or
   * sitting unlinked in the account), the registrar (RDASH — it can be moved
   * to Cloudflare), or somebody else entirely.
   */
  dns: 'cloudflare' | 'registrar' | 'external' | 'unknown';
  /** A/AAAA/CNAME records at the hostname that point somewhere else — removed only with consent */
  replaces: { type: string; content: string }[];
  /** a record at the hostname already points at our node */
  pointsHere: boolean;
  /** the record the app gets: its node's address */
  target: DnsTarget | null;
  /** may this caller move the domain to Cloudflare (org owner/admin, never a shared domain) */
  canMove: boolean;
};

const DNS_TYPES = ['A', 'AAAA', 'CNAME'];
const asTarget = (address: string): DnsTarget => ({
  type: /^\d{1,3}(\.\d{1,3}){3}$/.test(address) ? 'A' : 'CNAME',
  content: address,
});

/** Where the app's record will point: the app's node, else the node it would get, else the platform default. */
async function previewTarget(
  req: AuthenticatedRequest,
  parent: Domain | undefined,
  opts: { excludeAppId?: string | undefined; serverId?: string | undefined; organizationId?: string | undefined },
): Promise<DnsTarget | null> {
  let ip: string | null | undefined;
  if (opts.excludeAppId) {
    ip = (await serverForApplication(opts.excludeAppId).catch(() => null))?.publicIp;
  } else if (opts.serverId && req.user!.role === 'SUPERADMIN') {
    ip = (await prisma.server.findUnique({ where: { id: opts.serverId }, select: { publicIp: true } }))?.publicIp;
  } else {
    const orgIds = await getOrgIds(req);
    const orgId =
      (opts.organizationId && (isPlatformAdmin(req) || orgIds.includes(opts.organizationId)) ? opts.organizationId : null) ??
      (parent && !parent.shared ? parent.organizationId : null) ??
      (orgIds.length === 1 ? orgIds[0] : null);
    if (orgId) {
      ip = (
        await prisma.organization.findUnique({ where: { id: orgId }, select: { defaultServer: { select: { publicIp: true } } } })
      )?.defaultServer?.publicIp;
    }
  }
  if (ip?.trim()) return asTarget(ip.trim());
  return getDefaultDnsTarget().catch(() => null);
}

/**
 * What a hostname means today, before an app takes it — for warning the user
 * and asking consent, not for deciding: create and rename enforce their rules.
 * `excludeAppId`: the app being renamed (or repointed), which keeps its own name.
 */
export async function inspectHost(
  req: AuthenticatedRequest,
  host: string,
  opts: { excludeAppId?: string | undefined; serverId?: string | undefined; organizationId?: string | undefined } = {},
): Promise<HostInspection> {
  const app = await prisma.application.findUnique({
    where: { domain: host },
    select: { id: true, name: true, organizationId: true },
  });
  const visible = app && (isPlatformAdmin(req) || (app.organizationId && (await getOrgIds(req)).includes(app.organizationId)));
  const usedBy =
    app && app.id !== opts.excludeAppId ? (visible ? { id: app.id, name: app.name } : { id: null, name: null }) : null;

  // only zones the caller could put an app under — public DNS, but no reason to widen it
  const parent = (
    await prisma.domain.findMany({
      where: { name: { in: candidateParents(host) }, OR: [await orgScope(req), { shared: true }] },
    })
  ).sort((a, b) => b.name.length - a.name.length)[0];

  const target = await previewTarget(req, parent, opts);
  const base = { usedBy, apex: !!parent && parent.name === host, target, replaces: [], pointsHere: false };
  if (!parent) return { ...base, dns: 'unknown', canMove: false };

  const canMove = !parent.shared && (isPlatformAdmin(req) || (!!parent.organizationId && (await canManageOrg(req, parent.organizationId))));

  // a zone in the account counts even before it is linked — create links it
  const zoneId = parent.cfZoneId ?? (await findCloudflareZone(parent.name).catch(() => null))?.id;
  if (!zoneId) {
    return { ...base, dns: parent.registrar === 'RDASH' ? 'registrar' : 'external', canMove };
  }

  const ours = new Set(
    [
      ...(await prisma.server.findMany({ select: { publicIp: true } })).map((s) => s.publicIp),
      target?.content,
      (await getDefaultDnsTarget().catch(() => null))?.content,
    ]
      .filter(Boolean)
      .map((value) => normalizeHost(value)),
  );
  const atHost = ((await listCloudflareDnsRecords(zoneId).catch(() => null)) ?? []).filter(
    (r: any) => normalizeHost(r?.name) === host && DNS_TYPES.includes(String(r?.type).toUpperCase()),
  );
  const here = (r: any) => ours.has(normalizeHost(r?.content));

  return {
    ...base,
    dns: 'cloudflare',
    canMove,
    pointsHere: atHost.some(here),
    replaces: atHost.filter((r: any) => !here(r)).map((r: any) => ({ type: String(r.type), content: String(r.content) })),
  };
}

/**
 * Get the app's hostname pointed at it, as far as the user agreed. A zone
 * sitting unlinked in the Cloudflare account is linked (no DNS change). With
 * consent: a registrar-run domain is moved to Cloudflare (records copied,
 * nameservers switched) and records at the hostname that point elsewhere are
 * replaced. Without consent nothing that exists is touched.
 */
export async function applyAppDns(
  req: AuthenticatedRequest,
  application: Pick<Application, 'id' | 'domain' | 'domainId'>,
  consent: boolean,
): Promise<HostnameOutcome> {
  let parent = application.domainId ? await prisma.domain.findUnique({ where: { id: application.domainId } }) : null;

  if (parent && !parent.cfZoneId) {
    parent = (await linkExistingCloudflareZone(parent).catch(() => null)) ?? parent;
    const canMove = !parent.shared && (isPlatformAdmin(req) || (!!parent.organizationId && (await canManageOrg(req, parent.organizationId))));
    if (!parent.cfZoneId && consent && parent.registrar === 'RDASH' && canMove) {
      await moveDomainToCloudflare(parent);
    }
  }

  const force = consent && (await mayForceDns(req, application.domainId));
  return ensureAppHostname(application, { force });
}

/** Overwriting a conflicting DNS record is an admin's call under a shared domain. */
export async function mayForceDns(req: AuthenticatedRequest, domainId: string | null): Promise<boolean> {
  if (isPlatformAdmin(req) || !domainId) return true;
  const parent = await prisma.domain.findUnique({ where: { id: domainId }, select: { shared: true } });
  return !parent?.shared;
}
