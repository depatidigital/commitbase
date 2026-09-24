import { Resolver } from 'dns/promises';
import { execRoot, type SshTarget } from '../lib/runner';
import { prisma } from '../lib/prisma';
import { allRoutesOf, ensureHttpsListener, getCaddyConfig } from './caddyService';
import { findCloudflareZone, listCloudflareDnsRecords, updateDnsRecord } from './cloudflareService';
import { localCode } from './nginxMigrateService';

/**
 * First certificates for hostnames behind Cloudflare's proxy.
 *
 * Let's Encrypt cannot reach the node through an orange-cloud record when the
 * zone forces HTTPS: the challenge is redirected to an origin that has no
 * certificate yet, and fails with a 525. So: grey-cloud the records, let Caddy
 * ask again, wait for the certificates, orange-cloud them back. Done for every
 * name at once, so Caddy restarts once however many need it.
 *
 * Only the first one needs this. Once Caddy holds a certificate, renewals get
 * through the proxy — Caddy answers the ACME challenge over HTTPS too.
 *
 * The proxy is always put back, whatever happens in between: a record left
 * grey exposes the origin's address for as long as nobody notices.
 */

/** Nodes being provisioned now: each run restarts that node's Caddy, so one at a time. */
export const sslRunning = new Set<string>();

/** A run's outcome in the Log page. */
export const logSsl = (serverName: string, userId: string, result: SslProvisionResult) =>
  prisma.log.create({
    data: {
      level: result.ok ? 'INFO' : 'WARN',
      message:
        `SSL on ${serverName}: ${result.message} [${result.steps.join(' → ')}]` +
        (result.skipped.length ? ` Skipped: ${result.skipped.map((s) => `${s.host} (${s.reason})`).join('; ')}` : ''),
      userId,
    },
  });

/**
 * provisionCertificates after the answer — minutes of work — its outcome in the
 * Log when it did or skipped something. false: one is already running on the node.
 */
export function provisionInBackground(node: SshTarget & { id: string; publicIp: string; name?: string }, hosts: string[], userId: string): boolean {
  if (hosts.length === 0 || sslRunning.has(node.id)) return false;
  sslRunning.add(node.id);
  void provisionCertificates(node, hosts)
    .then((ssl) => (ssl.steps.length || ssl.skipped.length ? logSsl(node.name ?? node.hostname, userId, ssl) : undefined))
    .catch((error) => console.error(`SSL on ${node.name ?? node.hostname}:`, error?.message))
    .finally(() => sslRunning.delete(node.id));
  return true;
}

const DNS_WAIT_MS = 5 * 60_000;
const CERT_WAIT_MS = 6 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type SslProvisionResult = {
  ok: boolean;
  message: string;
  steps: string[];
  /** hosts that have a valid certificate now (including those that already did) */
  issued: string[];
  /** hosts left as they were, and why */
  skipped: Array<{ host: string; reason: string }>;
};

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
    // a short TTL while grey, so resolvers let go of it quickly; its own when proxied again
    ttl: proxied ? record.ttl : 60,
    proxied,
  });

/** The last hour of Caddy's log on the node — where ACME says why it did not issue. */
async function caddyJournal(node: SshTarget): Promise<string[]> {
  const { stdout } = await execRoot(node, ['journalctl', '-u', 'caddy-api', '--since', '1 hour ago', '--no-pager', '-o', 'cat'], {
    timeout: 30_000,
  }).catch(() => ({ stdout: '' }) as any);
  return String(stdout).split('\n');
}

const RATE_LIMITED = /rateLimited|too many (failed authorizations|certificates|new orders)/i;

/**
 * Is Let's Encrypt refusing this name for now? Switching its proxy off would
 * only expose the origin for nothing — and every failed try extends the wait. Pure.
 */
export function rateLimitOf(journal: string[], host: string): string | null {
  const line = [...journal].reverse().find((l) => l.includes(host) && RATE_LIMITED.test(l));
  if (!line) return null;
  const after = /retry after ([^",}]+)/i.exec(line)?.[1]?.trim();
  return `Let's Encrypt is rate-limiting it${after ? ` until ${after}` : ''} — try again later`;
}

/** The last thing ACME said about this name, for the log. Pure. */
export function lastAcmeError(journal: string[], host: string): string | null {
  const line = [...journal].reverse().find((l) => l.includes(host) && /error|fail/i.test(l));
  if (!line) return null;
  // Caddy logs JSON; the error field is the readable part
  try {
    const entry = JSON.parse(line);
    return String(entry.error ?? entry.msg ?? line).slice(0, 300);
  } catch {
    return line.slice(0, 300);
  }
}

/** Every hostname Caddy routes on this node that is not the panel's own infrastructure. */
export function caddyHostsOf(config: any): string[] {
  return [
    ...new Set(
      allRoutesOf(config).flatMap((route: any) => (route?.match ?? []).flatMap((m: any) => (Array.isArray(m?.host) ? m.host : []))),
    ),
  ].filter((host): host is string => typeof host === 'string' && !host.startsWith('*.'));
}

export async function provisionCertificates(node: SshTarget & { publicIp: string }, rawHosts: string[]): Promise<SslProvisionResult> {
  const steps: string[] = [];
  const issued: string[] = [];
  const skipped: SslProvisionResult['skipped'] = [];
  const done = (ok: boolean, message: string): SslProvisionResult => ({ ok, message, steps, issued, skipped });

  const config = await getCaddyConfig(node).catch(() => null);
  if (!config) return done(false, 'Caddy is not running on this node.');
  // nothing on :443 means no certificate can be served, whatever happens below
  if (await ensureHttpsListener(node)) steps.push('Caddy now listens on :443');
  const routed = new Set(caddyHostsOf(config));

  // which of them need one: routed here, no valid certificate yet, not refused by
  // Let's Encrypt right now, and a proxied record the panel can switch
  const journal = await caddyJournal(node);
  const todo: Array<{ host: string; zoneId: string; proxied: any[] }> = [];
  await Promise.all(
    [...new Set(rawHosts.map((host) => host.trim().toLowerCase()))].map(async (host) => {
      if (!routed.has(host)) return skipped.push({ host, reason: 'Caddy has no route for it here' });
      if (await localCode(node, host)) return issued.push(host);
      const limited = rateLimitOf(journal, host);
      if (limited) return skipped.push({ host, reason: limited });
      const found = await recordsOf(host);
      if (!found) return skipped.push({ host, reason: "not in a zone of the panel's Cloudflare account" });
      if (!found.records.some((r) => r.content === node.publicIp)) return skipped.push({ host, reason: `does not point at ${node.publicIp} in Cloudflare` });
      return todo.push({ host, zoneId: found.zoneId, proxied: found.records.filter((r) => r.proxied === true) });
    }),
  );
  if (todo.length === 0) return done(skipped.length === 0, issued.length ? 'Every hostname has a certificate.' : 'Nothing to provision.');

  const names = todo.map((t) => t.host).join(', ');
  try {
    for (const { zoneId, proxied } of todo) for (const record of proxied) await setProxied(zoneId, record, false);
    steps.push(`Cloudflare proxy off: ${names}`);

    // Cloudflare's own resolver answers from the authoritative data straight away
    const resolver = new Resolver();
    resolver.setServers(['1.1.1.1']);
    const dnsDeadline = Date.now() + DNS_WAIT_MS;
    for (const { host } of todo) {
      while (!(await resolver.resolve4(host).catch(() => [] as string[])).includes(node.publicIp)) {
        if (Date.now() > dnsDeadline) throw new Error(`${host} still does not resolve to ${node.publicIp} after ${DNS_WAIT_MS / 60_000} minutes`);
        await sleep(5000);
      }
    }
    steps.push('resolving to the node');

    // a restart makes Caddy ask for every missing certificate now, not at its next retry
    await execRoot(node, ['systemctl', 'restart', 'caddy-api'], { timeout: 60_000 });
    steps.push('Caddy restarted');

    const certDeadline = Date.now() + CERT_WAIT_MS;
    let waiting = todo.map((t) => t.host);
    while (waiting.length) {
      const answered = await Promise.all(waiting.map(async (host) => [host, (await localCode(node, host)) > 0] as const));
      for (const [host, ok] of answered) if (ok) issued.push(host);
      waiting = answered.filter(([, ok]) => !ok).map(([host]) => host);
      if (!waiting.length) break;
      if (Date.now() > certDeadline) {
        const after = await caddyJournal(node);
        for (const host of waiting) {
          skipped.push({ host, reason: `no certificate after ${CERT_WAIT_MS / 60_000} minutes: ${lastAcmeError(after, host) ?? 'nothing in the Caddy log — see journalctl -u caddy-api'}` });
        }
        break;
      }
      await sleep(5000);
    }
    steps.push(`certificates issued: ${todo.filter((t) => issued.includes(t.host)).length} of ${todo.length}`);
    return done(skipped.length === 0, `${issued.length} hostname(s) have a valid certificate.`);
  } catch (error: any) {
    for (const { host } of todo) if (!issued.includes(host)) skipped.push({ host, reason: String(error?.message || error) });
    return done(false, String(error?.message || error));
  } finally {
    // put every proxy back no matter what: three tries each before giving up loudly
    const stuck: string[] = [];
    for (const { zoneId, proxied } of todo) {
      for (const record of proxied) {
        let restored = false;
        for (let attempt = 0; attempt < 3 && !restored; attempt++) {
          restored = await setProxied(zoneId, record, true).then(
            () => true,
            async () => (await sleep(2000), false),
          );
        }
        if (!restored) stuck.push(record.name);
      }
    }
    steps.push(stuck.length ? `COULD NOT turn the Cloudflare proxy back on for ${stuck.join(', ')} — do it by hand` : 'Cloudflare proxy back on');
  }
}
