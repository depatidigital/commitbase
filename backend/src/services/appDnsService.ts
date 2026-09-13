import * as https from 'https';
import { isIPv4 } from 'net';
import { resolve4 } from 'node:dns/promises';
import { Application } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  listCloudflareDnsRecords,
  createDnsRecord,
  updateDnsRecord,
  deleteDnsRecord,
  getDefaultDnsTarget,
} from './cloudflareService';
import { refreshDomainSummary } from './domainSyncService';
import { serverForApplication } from '../lib/servers';

/**
 * DNS for an application's hostname.
 *
 * Deploying used to configure Caddy and start the process but never point the
 * name at us, so a "running" app did not resolve. Everything here closes that
 * gap, and says plainly when it cannot.
 *
 * Records are created DNS-only (never proxied): Caddy takes the certificate
 * itself over HTTP-01, and Cloudflare's proxy would answer that challenge
 * instead.
 * ponytail: DNS-only means the origin IP is public. Switch to proxied records
 * once Caddy issues certificates over DNS-01 with a Cloudflare token.
 */

export type HostnameOutcome =
  | { state: 'created'; detail: string }
  | { state: 'wildcard'; detail: string }
  | { state: 'exists'; detail: string }
  | { state: 'conflict'; detail: string }
  | { state: 'unavailable'; detail: string };

const lower = (value: unknown) => String(value ?? '').trim().toLowerCase();

/** every zone name the hostname could sit in, longest first */
const parentNames = (host: string): string[] => {
  const parts = lower(host).split('.');
  return parts.map((_, i) => parts.slice(i).join('.')).filter((name) => name.includes('.'));
};

type DnsTarget = { type: 'A' | 'CNAME'; content: string };

const asTarget = (address: string): DnsTarget => ({
  type: /^\d{1,3}(\.\d{1,3}){3}$/.test(address) ? 'A' : 'CNAME',
  content: address,
});

/**
 * Where an app's hostname should point: the public address of the node it runs
 * on. Organizations span nodes, so one platform-wide address is only right for
 * apps on that one box; it stays the fallback for an app with no node yet.
 */
async function targetForApp(applicationId: string): Promise<DnsTarget | null> {
  const node = await serverForApplication(applicationId).catch(() => null);
  if (node?.publicIp?.trim()) return asTarget(node.publicIp.trim());
  return getDefaultDnsTarget();
}

/** Whether the app's hostname sits in a Cloudflare zone we run — the only DNS "point it here" can write. */
export const dnsManaged = async (application: Pick<Application, 'domainId' | 'domain'>) => !!(await zoneFor(application));

/** The zone the app's hostname belongs to, or null when we do not run its DNS. */
async function zoneFor(application: Pick<Application, 'domainId' | 'domain'>) {
  const domain = application.domainId
    ? await prisma.domain.findUnique({ where: { id: application.domainId } })
    : await prisma.domain.findFirst({
        where: { name: { in: parentNames(application.domain) } },
        orderBy: { name: 'desc' },
      });

  return domain?.cfZoneId ? { domain, zoneId: domain.cfZoneId } : null;
}

/**
 * Point the app's hostname at the platform. Idempotent, so a deploy can call it
 * again to heal a record someone removed by hand.
 *
 * A record that already points somewhere else is left alone and reported as a
 * conflict — silently stealing a live hostname is worse than an unreachable
 * app. `force` overwrites it, for the caller that has asked the user.
 */
export async function ensureAppHostname(
  application: Pick<Application, 'id' | 'domain' | 'domainId'>,
  { force = false }: { force?: boolean } = {},
): Promise<HostnameOutcome> {
  const host = lower(application.domain);
  const zone = await zoneFor(application);

  if (!zone) {
    return {
      state: 'unavailable',
      detail: `${host} is not in a zone we run — add the record with whoever hosts its DNS`,
    };
  }

  const target = await targetForApp(application.id);
  if (!target) {
    return { state: 'unavailable', detail: 'No platform DNS target is configured' };
  }

  const records = (await listCloudflareDnsRecords(zone.zoneId)) ?? [];
  const pointsAtUs = (record: any) => lower(record?.content) === lower(target.content);

  // every address record at the name — an explicit one wins over the wildcard,
  // so these decide first
  const atHost = records.filter(
    (record: any) =>
      lower(record?.name) === host && ['A', 'AAAA', 'CNAME'].includes(String(record?.type).toUpperCase()),
  );
  const elsewhere = atHost.filter((record: any) => !pointsAtUs(record));

  if (elsewhere.length && !force) {
    // one of ours next to a stray AAAA still serves: leave it be unless asked
    if (atHost.some(pointsAtUs)) return { state: 'exists', detail: `${host} already points here` };
    return {
      state: 'conflict',
      detail: `${host} already points at ${elsewhere[0].content} — repoint it to deploy here`,
    };
  }

  // forced: the user agreed to replace them — a CNAME cannot sit next to our A anyway
  for (const record of elsewhere) await deleteDnsRecord(zone.zoneId, record.id);

  if (atHost.some(pointsAtUs)) {
    if (elsewhere.length) await refreshDomainSummary(zone.domain.id);
    return { state: 'exists', detail: `${host} already points here` };
  }

  // a wildcard on the zone already answers for every hostname under it
  const wildcard = records.find(
    (record: any) => lower(record?.name) === `*.${lower(zone.domain.name)}` && pointsAtUs(record),
  );
  if (wildcard && host !== lower(zone.domain.name)) {
    if (elsewhere.length) await refreshDomainSummary(zone.domain.id);
    return { state: 'wildcard', detail: `Covered by the ${wildcard.name} record` };
  }

  await createDnsRecord(zone.zoneId, { type: target.type, name: host, content: target.content, ttl: 1, proxied: false });

  await refreshDomainSummary(zone.domain.id);
  return {
    state: 'created',
    detail: elsewhere.length
      ? `${host} → ${target.content} (replaced ${elsewhere.map((r: any) => `${r.type} ${r.content}`).join(', ')})`
      : `${host} → ${target.content}`,
  };
}

/** Drop the record the deploy created. A wildcard or a hand-made record stays. */
export async function removeAppHostname(
  application: Pick<Application, 'id' | 'domain' | 'domainId'>,
  // teardown is all-or-nothing, so there a failed removal must stop the delete
  { strict = false }: { strict?: boolean } = {},
): Promise<void> {
  try {
    const host = lower(application.domain);
    const zone = await zoneFor(application);
    if (!zone) return;

    const target = await targetForApp(application.id);
    if (!target) return;

    const records = (await listCloudflareDnsRecords(zone.zoneId)) ?? [];
    const ours = records.find(
      (record: any) =>
        lower(record?.name) === host &&
        // only the record pointing at us — anything else was somebody's decision
        lower(record?.content) === lower(target.content),
    );

    if (!ours) return;
    await deleteDnsRecord(zone.zoneId, ours.id);
    await refreshDomainSummary(zone.domain.id);
  } catch (error: any) {
    if (strict) throw error;
    // never block deleting the app on a DNS cleanup
    console.error(`Could not remove DNS for ${application.domain}:`, error?.message);
  }
}

/**
 * One `*.domain` record instead of one per app: nothing to create at deploy
 * time and nothing to clean up. Used for domains we register ourselves, where
 * the whole zone is ours to point.
 */
export async function ensureWildcardRecord(domainId: string): Promise<HostnameOutcome> {
  const domain = await prisma.domain.findUnique({
    where: { id: domainId },
    include: { organization: { select: { defaultServer: { select: { publicIp: true } } } } },
  });
  if (!domain?.cfZoneId) {
    return { state: 'unavailable', detail: 'Domain has no Cloudflare zone' };
  }

  // The wildcard answers for apps on the org's default server; an app on
  // another node gets its own record, which wins over the wildcard.
  const defaultIp = domain.organization?.defaultServer?.publicIp?.trim();
  const target = defaultIp ? asTarget(defaultIp) : await getDefaultDnsTarget();
  if (!target) return { state: 'unavailable', detail: 'No platform DNS target is configured' };

  const name = `*.${lower(domain.name)}`;
  const records = (await listCloudflareDnsRecords(domain.cfZoneId)) ?? [];
  const existing = records.find((record: any) => lower(record?.name) === name);

  if (existing && lower(existing.content) === lower(target.content)) {
    return { state: 'exists', detail: `${name} already points here` };
  }

  const record = { type: target.type, name, content: target.content, ttl: 1, proxied: false };
  if (existing) {
    await updateDnsRecord(domain.cfZoneId, existing.id, record);
  } else {
    await createDnsRecord(domain.cfZoneId, record);
  }

  await refreshDomainSummary(domain.id);
  return { state: 'created', detail: `${name} → ${target.content}` };
}

export type HostnameHealth = {
  host: string;
  /** the name answers on the public internet */
  resolves: boolean;
  /** TLS handshake completed with a certificate this platform trusts */
  https: boolean;
  /** what the site replied, when it replied at all */
  httpStatus: number | null;
  /** live means: resolves, valid certificate, and not a server error */
  live: boolean;
  error: string | null;
};

/**
 * Is the site actually reachable? "RUNNING" only ever meant "the unit started",
 * which is not what anyone reads it as — this asks the hostname itself.
 */
export async function checkAppHostname(host: string, timeoutMs = 5000): Promise<HostnameHealth> {
  const name = lower(host);
  const base: HostnameHealth = {
    host: name,
    resolves: false,
    https: false,
    httpStatus: null,
    live: false,
    error: null,
  };

  return new Promise<HostnameHealth>((resolve) => {
    const request = https.request(
      { host: name, port: 443, path: '/', method: 'GET', timeout: timeoutMs, servername: name },
      (response) => {
        response.resume();
        const status = response.statusCode ?? null;
        resolve({
          ...base,
          resolves: true,
          https: true,
          httpStatus: status,
          live: !!status && status < 500,
        });
      },
    );

    request.on('timeout', () => {
      request.destroy();
      resolve({ ...base, error: 'No answer within the timeout' });
    });

    request.on('error', (error: any) => {
      const code = String(error?.code ?? '');
      // DNS saying nothing exists is a different problem from TLS not being ready
      const missing = code === 'ENOTFOUND' || code === 'EAI_AGAIN';
      resolve({
        ...base,
        resolves: !missing,
        error: missing
          ? 'Hostname does not resolve yet'
          : String(error?.message ?? 'Could not reach the hostname').slice(0, 200),
      });
    });

    request.end();
  });
}

// Cloudflare's published edge ranges (cloudflare.com/ips-v4). An answer inside
// them is the orange cloud: public DNS then says nothing about the origin.
// ponytail: a static copy — refresh from that page if Cloudflare adds ranges.
const CLOUDFLARE_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];

const ipv4ToInt = (ip: string) => ip.split('.').reduce((n, octet) => (n << 8) + Number(octet), 0) >>> 0;

/** Whether an IPv4 address is one of Cloudflare's edge addresses. Pure. */
export function isCloudflareIp(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const address = ipv4ToInt(ip);
  return CLOUDFLARE_V4.some((cidr) => {
    const [base, bits] = cidr.split('/');
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return (address & mask) === (ipv4ToInt(base!) & mask);
  });
}

export type DnsPointing = {
  /** here: at this app's server · elsewhere: somewhere else · proxied: behind Cloudflare, origin unknown to us · none: no A record */
  state: 'here' | 'elsewhere' | 'proxied' | 'none';
  /** what public DNS answers */
  addresses: string[];
  /** behind the orange cloud, the record's real target — read from our Cloudflare zone */
  origin: string | null;
  /** what "here" means: the server's address (or the platform DNS target) */
  expected: string | null;
  /** pointing elsewhere, at another server registered in this panel — the app probably runs there */
  otherServer?: { id: string; name: string } | null;
};

/** The registered server a DNS target is — by public IP or SSH hostname. */
async function registeredServerAt(targets: string[]) {
  const values = targets.map(lower).filter(Boolean);
  if (!values.length) return null;
  return prisma.server.findFirst({
    where: { OR: [{ publicIp: { in: values } }, { hostname: { in: values } }] },
    select: { id: true, name: true },
  });
}

/**
 * Where the app's hostname really sends visitors, compared with the server it
 * runs on. Public DNS for a proxied record only shows Cloudflare; when the zone
 * is ours, the record itself names the origin.
 */
export async function whereHostnamePoints(application: Pick<Application, 'id' | 'domain' | 'domainId'>): Promise<DnsPointing> {
  const host = lower(application.domain);
  const target = await targetForApp(application.id);
  const expected = target?.content ?? null;
  const addresses = await resolve4(host).catch(() => [] as string[]);

  if (!addresses.length) return { state: 'none', addresses, origin: null, expected };
  if (expected && addresses.includes(expected)) return { state: 'here', addresses, origin: null, expected };
  if (!addresses.every(isCloudflareIp)) {
    return { state: 'elsewhere', addresses, origin: null, expected, otherServer: await registeredServerAt(addresses) };
  }

  // proxied: ask our own zone what the record points at
  const zone = await zoneFor(application).catch(() => null);
  const records = zone ? (await listCloudflareDnsRecords(zone.zoneId)) ?? [] : [];
  const address = (name: string) => records.find((r: any) => lower(r?.name) === name && (r?.type === 'A' || r?.type === 'CNAME'));
  // an explicit record wins; otherwise the zone's wildcard is what answers
  const record = address(host) ?? (zone ? address(`*.${lower(zone.domain.name)}`) : undefined);
  if (!record) return { state: 'proxied', addresses, origin: null, expected };

  const origin = String(record.content);
  if (expected && lower(origin) === lower(expected)) return { state: 'here', addresses, origin, expected };
  return { state: 'elsewhere', addresses, origin, expected, otherServer: await registeredServerAt([origin]) };
}
