import { prisma } from '../lib/prisma';
import { allServers } from '../lib/servers';
import type { SshTarget } from '../lib/runner';
import {
  getCaddyConfig,
  replaceCaddyConfig,
  routeHostsOf,
  listCaddyRouteHosts,
} from './caddyService';

/**
 * Backup and restore for each node's live Caddy configuration.
 *
 * Caddy holds the admin-API config in memory only, and the `.caddy` site files
 * that used to back it are gone — so a `systemctl reload caddy` reads the bare
 * Caddyfile and every tenant route disappears with nothing on disk to rebuild
 * it from. A PHP site's FPM socket and document root in particular exist
 * nowhere else.
 *
 * So: snapshot each node's config while it looks healthy, and push the last
 * good one back when routes go missing. Snapshots are per node — every box runs
 * its own Caddy, and a config is only restorable onto the box it came from.
 *
 * ponytail: keeps the last KEEP snapshots per node and always picks the newest.
 * That is a backup, not a history — add a "restore this one" action if an admin
 * ever needs a specific point rather than the latest.
 */

const KEEP = 10;

/** Store one node's live config, if there is anything worth storing. */
export async function snapshotNode(node: SshTarget): Promise<string> {
  const config = await getCaddyConfig(node);
  if (config === null) return `${node.hostname}: skipped — Caddy did not answer`;

  const hosts = routeHostsOf(config);
  if (hosts.length === 0) return `${node.hostname}: skipped — no routes to snapshot`;

  const latest = await prisma.caddySnapshot.findFirst({
    where: { serverId: node.id },
    orderBy: { createdAt: 'desc' },
  });

  // nothing changed since the last one — a snapshot per tick would be noise
  if (latest && JSON.stringify(latest.config) === JSON.stringify(config)) {
    return `${node.hostname}: unchanged, ${hosts.length} route(s)`;
  }

  await prisma.caddySnapshot.create({ data: { serverId: node.id, config, hosts } });

  const stale = await prisma.caddySnapshot.findMany({
    where: { serverId: node.id },
    orderBy: { createdAt: 'desc' },
    skip: KEEP,
    select: { id: true },
  });
  if (stale.length > 0) {
    await prisma.caddySnapshot.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
  }

  return `${node.hostname}: snapshotted ${hosts.length} route(s)`;
}

/** Snapshot every node. */
export async function snapshotCaddyConfig(): Promise<string> {
  const nodes = await allServers();
  if (nodes.length === 0) return 'skipped — no servers registered';

  const lines: string[] = [];
  for (const node of nodes) {
    try {
      lines.push(await snapshotNode(node));
    } catch (error: any) {
      lines.push(`${node.hostname}: ${error?.message ?? 'snapshot failed'}`);
    }
  }
  return lines.join('; ');
}

/** Push a node's newest snapshot back into its Caddy. */
export async function restoreNode(node: SshTarget): Promise<{ restored: boolean; hosts: string[] }> {
  const latest = await prisma.caddySnapshot.findFirst({
    where: { serverId: node.id },
    orderBy: { createdAt: 'desc' },
  });
  if (!latest) return { restored: false, hosts: [] };

  await replaceCaddyConfig(node, latest.config);
  return { restored: true, hosts: latest.hosts };
}

/** Restore every node that has a snapshot. */
export async function restoreCaddyConfig(): Promise<{ restored: boolean; hosts: string[] }> {
  const nodes = await allServers();
  const hosts: string[] = [];
  let restored = false;

  for (const node of nodes) {
    const result = await restoreNode(node);
    if (result.restored) {
      restored = true;
      hosts.push(...result.hosts);
    }
  }

  return { restored, hosts };
}

/**
 * The watchdog. For each node, compares what its Caddy is serving against what
 * should be there — the snapshot's hostnames plus every app the database
 * expects to be running on that node — and heals the difference: the snapshot
 * first (it carries the sites we cannot rebuild), then the platform's own
 * routes on top, since a port may have moved since the snapshot was taken.
 */
export async function healCaddyRoutes(): Promise<string> {
  const nodes = await allServers();
  if (nodes.length === 0) return 'skipped — no servers registered';

  const { DeploymentService } = await import('./deployment');
  const deployment = new DeploymentService();
  const lines: string[] = [];
  let healedAny = false;

  for (const node of nodes) {
    try {
      const live = await listCaddyRouteHosts(node);
      if (live === null) {
        lines.push(`${node.hostname}: unreachable`);
        continue;
      }

      const latest = await prisma.caddySnapshot.findFirst({
        where: { serverId: node.id },
        orderBy: { createdAt: 'desc' },
      });

      const expected = [
        ...new Set([...(latest?.hosts ?? []), ...(await deployment.expectedCaddyHosts(node.id))]),
      ];
      const missing = expected.filter((host) => !live.includes(host));

      if (missing.length === 0) {
        // healthy — this is the moment worth remembering
        lines.push(await snapshotNode(node));
        continue;
      }

      healedAny = true;
      const restored = await restoreNode(node);
      lines.push(
        `${node.hostname}: ${missing.length} route(s) missing (${missing.slice(0, 5).join(', ')})${
          restored.restored ? `, restored ${restored.hosts.length} from snapshot` : ''
        }`,
      );
    } catch (error: any) {
      lines.push(`${node.hostname}: ${error?.message ?? 'heal failed'}`);
    }
  }

  // Ports and origins can have moved since a snapshot, so the platform's own
  // routes are written again on top of whatever was restored.
  if (healedAny) {
    const { applied, failed } = await deployment.reapplyCaddyRoutes();
    lines.push(`re-applied ${applied}${failed ? `, ${failed} failed` : ''}`);
  }

  return lines.join('; ');
}
