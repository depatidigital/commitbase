import { Resolver } from 'dns/promises';
import { execRoot, type SshTarget } from '../lib/runner';
import { allRoutesOf, getCaddyConfig } from './caddyService';
import { findCloudflareZone, listCloudflareDnsRecords, updateDnsRecord } from './cloudflareService';
import { localCode } from './nginxMigrateService';

/**
 * A first certificate for a hostname behind Cloudflare's proxy.
 *
 * Let's Encrypt cannot reach the node through an orange-cloud record when the
 * zone forces HTTPS: the challenge is redirected to an origin that has no
 * certificate yet, and fails with a 525. So: grey-cloud the record, let Caddy
 * ask again, wait for the certificate, orange-cloud it back.
 *
 * Only the first one needs this. Once Caddy holds a certificate, renewals get
 * through the proxy — Caddy answers the ACME challenge over HTTPS too.
 *
 * The proxy is always put back, whatever happens in between: a record left
 * grey exposes the origin's address for as long as nobody notices.
 */

const DNS_WAIT_MS = 5 * 60_000;
const CERT_WAIT_MS = 6 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type SslProvisionResult = { ok: boolean; message: string; steps: string[] };

/** The zone in the panel's Cloudflare account that holds this hostname, and its A/AAAA records. */
async function recordsOf(host: string): Promise<{ zoneId: string; records: any[] } | null> {
  const labels = host.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const zone = await findCloudflareZone(labels.slice(i).join('.')).catch(() => null);
    if (!zone) continue;
    const all = (await listCloudflareDnsRecords(zone.id)) ?? [];
    return { zoneId: zone.id, records: all.filter((r: any) => String(r?.name).toLowerCase() === host && (r?.type === 'A' || r?.type === 'AAAA')) };
  }
  return null;
}

const setProxied = (zoneId: string, record: any, proxied: boolean) =>
  updateDnsRecord(zoneId, record.id, {
    type: record.type,
    name: record.name,
    content: record.content,
    // a short TTL while grey, so resolvers let go of it quickly; auto when proxied again
    ttl: proxied ? record.ttl : 60,
    proxied,
  });

export async function provisionCertificate(node: SshTarget & { publicIp: string }, rawHost: string): Promise<SslProvisionResult> {
  const host = rawHost.trim().toLowerCase();
  const steps: string[] = [];

  const config = await getCaddyConfig(node).catch(() => null);
  if (!config) return { ok: false, message: 'Caddy is not running on this node.', steps };
  const served = allRoutesOf(config).some((route: any) => (route?.match ?? []).some((m: any) => (m?.host ?? []).includes(host)));
  if (!served) return { ok: false, message: `Caddy has no route for ${host} on this node.`, steps };

  if (await localCode(node, host)) return { ok: true, message: `${host} already has a valid certificate.`, steps };

  const found = await recordsOf(host);
  if (!found) return { ok: false, message: `${host} is not in a zone of the panel's Cloudflare account, so its proxy cannot be switched from here.`, steps };
  if (!found.records.some((r) => r.content === node.publicIp)) {
    return { ok: false, message: `${host} does not point at this node (${node.publicIp}) in Cloudflare.`, steps };
  }
  const proxied = found.records.filter((r) => r.proxied === true);

  try {
    for (const record of proxied) await setProxied(found.zoneId, record, false);
    if (proxied.length) steps.push('Cloudflare proxy off (DNS only)');

    // Cloudflare's own resolver answers from the authoritative data straight away
    const resolver = new Resolver();
    resolver.setServers(['1.1.1.1']);
    const dnsDeadline = Date.now() + DNS_WAIT_MS;
    while (!(await resolver.resolve4(host).catch(() => [] as string[])).includes(node.publicIp)) {
      if (Date.now() > dnsDeadline) throw new Error(`${host} still does not resolve to ${node.publicIp} after ${DNS_WAIT_MS / 60_000} minutes`);
      await sleep(5000);
    }
    steps.push(`${host} resolves to the node`);

    // a restart makes Caddy ask for every missing certificate now, not at its next retry
    await execRoot(node, ['systemctl', 'restart', 'caddy-api'], { timeout: 60_000 });
    steps.push('Caddy restarted');

    const certDeadline = Date.now() + CERT_WAIT_MS;
    while (!(await localCode(node, host))) {
      if (Date.now() > certDeadline) throw new Error(`no certificate for ${host} after ${CERT_WAIT_MS / 60_000} minutes — see journalctl -u caddy-api on the node`);
      await sleep(5000);
    }
    steps.push('Certificate issued');
    return { ok: true, message: `${host} has a valid certificate now.`, steps };
  } catch (error: any) {
    return { ok: false, message: String(error?.message || error), steps };
  } finally {
    // put the proxy back no matter what: tried three times before giving up loudly
    for (const record of proxied) {
      let restored = false;
      for (let attempt = 0; attempt < 3 && !restored; attempt++) {
        restored = await setProxied(found.zoneId, record, true).then(
          () => true,
          async () => (await sleep(2000), false),
        );
      }
      steps.push(restored ? 'Cloudflare proxy back on' : `COULD NOT turn the Cloudflare proxy back on for ${record.name} — do it by hand`);
    }
  }
}
