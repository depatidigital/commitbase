import { prisma } from '../lib/prisma';
import {
  getCaddyConfig,
  replaceCaddyConfig,
  routeHostsOf,
  listCaddyRouteHosts,
} from './caddyService';

/**
 * Backup and restore for Caddy's live configuration.
 *
 * Caddy holds the admin-API config in memory only, and the `.caddy` site files
 * that used to back it are gone — so a `systemctl reload caddy` reads the bare
 * Caddyfile and every tenant route disappears with nothing on disk to rebuild
 * it from. A PHP site's FPM socket and document root in particular exist
 * nowhere else.
 *
 * So: snapshot the live config whenever it looks healthy, and push the last
 * good one back when routes go missing.
 *
 * ponytail: keeps the last KEEP snapshots and picks the newest. That is a
 * backup, not a history — add a "restore this one" action if an admin ever
 * needs to roll back to a specific point rather than the latest.
 */

const KEEP = 10;

/** Store the live config, if there is anything worth storing. */
export async function snapshotCaddyConfig(): Promise<string> {
  const config = await getCaddyConfig();
  if (config === null) return 'skipped — Caddy did not answer';

  const hosts = routeHostsOf(config);
  if (hosts.length === 0) return 'skipped — no routes to snapshot';

  const latest = await prisma.caddySnapshot.findFirst({ orderBy: { createdAt: 'desc' } });

  // nothing changed since the last one — a snapshot per tick would be noise
  if (latest && JSON.stringify(latest.config) === JSON.stringify(config)) {
    return `unchanged — ${hosts.length} route(s)`;
  }

  await prisma.caddySnapshot.create({ data: { config, hosts } });

  const stale = await prisma.caddySnapshot.findMany({
    orderBy: { createdAt: 'desc' },
    skip: KEEP,
    select: { id: true },
  });
  if (stale.length > 0) {
    await prisma.caddySnapshot.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
  }

  return `snapshotted ${hosts.length} route(s)`;
}

/** Push the newest snapshot back into Caddy. */
export async function restoreCaddyConfig(): Promise<{ restored: boolean; hosts: string[] }> {
  const latest = await prisma.caddySnapshot.findFirst({ orderBy: { createdAt: 'desc' } });
  if (!latest) return { restored: false, hosts: [] };

  await replaceCaddyConfig(latest.config);
  return { restored: true, hosts: latest.hosts };
}

/**
 * The watchdog. Compares what Caddy is serving against what should be there —
 * the snapshot's hostnames plus every app the database expects to be running —
 * and heals the difference: the snapshot first (it carries the sites we cannot
 * rebuild), then the platform's own routes on top, since a port may have moved
 * since the snapshot was taken.
 */
export async function healCaddyRoutes(): Promise<string> {
  if (!process.env.CADDY_API_URL) return 'skipped — CADDY_API_URL is not set';

  const live = await listCaddyRouteHosts();
  if (live === null) return 'skipped — Caddy did not answer';

  const { DeploymentService } = await import('./deployment');
  const deployment = new DeploymentService();

  const latest = await prisma.caddySnapshot.findFirst({ orderBy: { createdAt: 'desc' } });
  const expected = [...new Set([...(latest?.hosts ?? []), ...(await deployment.expectedCaddyHosts())])];
  const missing = expected.filter((host) => !live.includes(host));

  if (missing.length === 0) {
    // healthy — this is the moment worth remembering
    return `${live.length} route(s) live — ${await snapshotCaddyConfig()}`;
  }

  const restored = await restoreCaddyConfig();
  const { applied, failed } = await deployment.reapplyCaddyRoutes();

  return `healed: ${missing.length} route(s) were missing (${missing.slice(0, 5).join(', ')}) — ${
    restored.restored ? `restored ${restored.hosts.length} from snapshot, ` : ''
  }re-applied ${applied}${failed ? `, ${failed} failed` : ''}`;
}
