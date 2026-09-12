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
 * Two kinds of snapshot:
 * - checkpoints: the config as found while healthy (health ticks, manual,
 *   registration) and after a write onto a whole config. The watchdog restores
 *   the newest checkpoint on its own.
 * - history: the config before and after every write the platform makes, so
 *   any change can be rolled back by picking the snapshot from before it.
 *   Never restored unasked — a write onto a config a reload had emptied would
 *   otherwise become what the watchdog puts back.
 */

const KEEP_CHECKPOINTS = 10;
const KEEP_HISTORY = 100;

/**
 * Store a config unless it matches the newest snapshot of the same kind.
 * Returns whether it was stored.
 */
export async function saveSnapshot(
  serverId: string,
  config: any,
  { reason, checkpoint }: { reason: string; checkpoint: boolean },
): Promise<boolean> {
  // The whole config is the backup, not just the parts this platform wrote:
  // TLS policies, other app blocks and sites nobody has imported yet all live
  // here, and all of them are lost by the same reload. Only a config with
  // nothing in it at all is worth skipping.
  if (!config || Object.keys(config).length === 0) return false;

  const latest = await prisma.caddySnapshot.findFirst({
    where: { serverId, checkpoint },
    orderBy: { createdAt: 'desc' },
    select: { config: true },
  });
  // nothing changed since the last one — a snapshot per tick would be noise
  if (latest && JSON.stringify(latest.config) === JSON.stringify(config)) return false;

  await prisma.caddySnapshot.create({
    data: { serverId, config, hosts: routeHostsOf(config), reason, checkpoint },
  });

  const stale = await prisma.caddySnapshot.findMany({
    where: { serverId, checkpoint },
    orderBy: { createdAt: 'desc' },
    skip: checkpoint ? KEEP_CHECKPOINTS : KEEP_HISTORY,
    select: { id: true },
  });
  if (stale.length > 0) {
    await prisma.caddySnapshot.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
  }
  return true;
}

/**
 * Whether `config` still serves every host of the newest checkpoint, `except`
 * the one being changed. A write onto such a config yields the next checkpoint;
 * a write onto one a reload emptied does not.
 */
export async function coversCheckpoint(serverId: string, config: any, except: string): Promise<boolean> {
  const latest = await prisma.caddySnapshot.findFirst({
    where: { serverId, checkpoint: true },
    orderBy: { createdAt: 'desc' },
    select: { hosts: true },
  });
  const live = new Set(routeHostsOf(config));
  return (latest?.hosts ?? []).every((host) => host === except || live.has(host));
}

/** Store one node's live config as a checkpoint, if there is anything worth storing. */
export async function snapshotNode(node: SshTarget, reason = 'health check'): Promise<string> {
  const config = await getCaddyConfig(node);
  if (config === null) return `${node.hostname}: skipped — Caddy did not answer`;
  if (Object.keys(config).length === 0) return `${node.hostname}: skipped — Caddy has no config`;

  const hosts = routeHostsOf(config);
  return (await saveSnapshot(node.id, config, { reason, checkpoint: true }))
    ? `${node.hostname}: snapshotted ${hosts.length} route(s)`
    : `${node.hostname}: unchanged, ${hosts.length} route(s)`;
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

/**
 * Push a snapshot back into a node's Caddy: the one picked, else the newest
 * checkpoint. The config it replaces is kept as history first (replaceCaddyConfig),
 * so a restore is itself undoable. `dropped`: hosts served before, gone after.
 */
export async function restoreNode(
  node: SshTarget,
  snapshotId?: string,
): Promise<{ restored: boolean; hosts: string[]; dropped: string[] }> {
  const snapshot = await prisma.caddySnapshot.findFirst({
    where: snapshotId ? { id: snapshotId, serverId: node.id } : { serverId: node.id, checkpoint: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!snapshot) return { restored: false, hosts: [], dropped: [] };

  const before = (await listCaddyRouteHosts(node)) ?? [];
  await replaceCaddyConfig(node, snapshot.config, `restore of ${snapshot.createdAt.toISOString()}`);
  return {
    restored: true,
    hosts: snapshot.hosts,
    dropped: before.filter((host) => !snapshot.hosts.includes(host)),
  };
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
        where: { serverId: node.id, checkpoint: true },
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
