import * as https from 'https';
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
