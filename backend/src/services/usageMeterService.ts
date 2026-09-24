import { prisma } from '../lib/prisma';
import { execRoot } from '../lib/runner';
import { ORG_SLUG_RE } from '../lib/appPaths';

/**
 * Pay for what you use: every few minutes, what each workspace used on each
 * node — CPU time and memory, read from the kernel's own counters (cgroup v2),
 * and the storage it holds — summed into one row per workspace and hour.
 *
 * A workspace's services run in its slice (cb-<slug>.slice), its compose
 * stacks in its user's rootless Podman (user@<uid>.service); both are read.
 * Imported services (pm2 of another user) are not the workspace's to meter.
 */

const GiB = 1024 ** 3;
/** a gap longer than this (the backend was down) is not billed as if memory was held throughout */
const MAX_INTERVAL_S = 15 * 60;

/**
 * CPU and memory per hour (Rp 30k per vCPU-month, Rp 80k per GB-month, over
 * 730 h); storage per GB-month, charged by the day — a day is the month's price
 * over its days, so a whole month is exactly the price.
 */
// ponytail: constants — a superadmin-edited price list when prices start to change
export const RATES = {
  cpuCoreHour: 41,
  memGbHour: 110,
  /** disk on a node: its cost with a quarter kept free, and the margin */
  storageGbMonth: 1500,
  /** object storage (R2, static sites): Rp 300 cost, no headroom needed, 2.5× */
  objectGbMonth: 750,
  currency: 'IDR',
} as const;

/** Stored in R2, not on a node: a static site's files. */
export const inObjectStorage = (app: { type: string; staticBucket: string | null }) => app.type === 'STATIC' && !!app.staticBucket;

/** The average month, where the month is not known: 730 h. */
const AVG_MONTH_DAYS = 730 / 24;

/**
 * Reads a unit's cgroup: CPU time used (µs, a counter) and memory now (bytes).
 * Straight from cgroupfs — present whatever systemd's accounting settings are.
 */
const CG = `cg() { p=$(systemctl show -p ControlGroup --value "$1" 2>/dev/null); d="/sys/fs/cgroup$p"; if [ -n "$p" ] && [ -d "$d" ]; then u=$(awk '/^usage_usec/{print $2}' "$d/cpu.stat" 2>/dev/null); m=$(cat "$d/memory.current" 2>/dev/null); echo "\${u:-0} \${m:-0}"; else echo "0 0"; fi; }`;

/**
 * The user's journal on this node: rootless podman's container logs (journald
 * driver) and its user services', in bytes. Exact names — user-200000 must not
 * take user-2000001's — persistent and volatile, archives and all.
 */
const JR = `jr() { du -cb /var/log/journal/*/user-$1.journal /var/log/journal/*/user-$1@*.journal* /run/log/journal/*/user-$1.journal /run/log/journal/*/user-$1@*.journal* 2>/dev/null | tail -1 | cut -f1; }`;

/** One line per workspace: `<orgId> <sliceUsec> <sliceMem> <podmanUsec> <podmanMem> <journalBytes>`. Slugs are checked, uids are numbers. */
export function meterScript(orgs: Array<{ id: string; slug: string; uid: number | null }>): string {
  const lines = orgs
    .filter((org) => ORG_SLUG_RE.test(org.slug) && /^[a-z0-9]+$/.test(org.id))
    .map((org) => {
      const uid = org.uid ? Number(org.uid) : null;
      return `echo "${org.id} $(cg cb-${org.slug}.slice) $(${uid ? `cg user@${uid}.service` : 'echo 0 0'}) $(${uid ? `jr ${uid}` : 'echo 0'})"`;
    });
  return [CG, JR, ...lines].join('\n');
}

export type Reading = { cpuUsec: bigint; memBytes: number; journalBytes: number };

/** Parse meterScript's output. Pure. */
export function parseMeter(stdout: string): Map<string, Reading> {
  const out = new Map<string, Reading>();
  for (const line of stdout.split('\n')) {
    const [id, u1, m1, u2, m2, j] = line.trim().split(/\s+/);
    if (!id || u1 === undefined) continue;
    const big = (v?: string) => (v && /^\d+$/.test(v) ? BigInt(v) : 0n);
    const num = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : 0);
    out.set(id, { cpuUsec: big(u1) + big(u2), memBytes: num(m1) + num(m2), journalBytes: num(j) });
  }
  return out;
}

/**
 * What was used since the last reading. Pure. The counter restarts from zero
 * when the slice does (a reboot, a re-provision): then all of it is new.
 * No previous reading: nothing yet — the next one has a delta.
 */
export function usageSince(
  prev: { cpuUsec: bigint | null; at: Date | null },
  now: Reading,
  at: Date,
): { cpuSeconds: number; memGbSeconds: number; seconds: number } | null {
  if (prev.cpuUsec === null || !prev.at) return null;
  const seconds = Math.min(MAX_INTERVAL_S, Math.max(0, (at.getTime() - prev.at.getTime()) / 1000));
  const cpuUsec = now.cpuUsec >= prev.cpuUsec ? now.cpuUsec - prev.cpuUsec : now.cpuUsec;
  return { cpuSeconds: Number(cpuUsec) / 1e6, memGbSeconds: (now.memBytes / GiB) * seconds, seconds };
}

export type Use = { cpuSeconds: number; memGbSeconds: number; storageGbSeconds: number; objectGbSeconds?: number };

/** Rupiah for an amount of use; disk and object storage by the day of a month of `monthDays`. Pure. */
export function priceOf(use: Use, monthDays = AVG_MONTH_DAYS) {
  const cpu = (use.cpuSeconds / 3600) * RATES.cpuCoreHour;
  const mem = (use.memGbSeconds / 3600) * RATES.memGbHour;
  const storage = (use.storageGbSeconds / 86_400) * (RATES.storageGbMonth / monthDays);
  const object = ((use.objectGbSeconds ?? 0) / 86_400) * (RATES.objectGbMonth / monthDays);
  return { cpu, mem, storage, object, total: cpu + mem + storage + object };
}

/**
 * What the workspace costs per hour right now: the storage it holds (measured
 * sizes, known at once), the memory at the last reading, and its CPU over the
 * last day. What the month's estimate runs forward on.
 */
export async function currentRate(organizationId: string, monthDays = AVG_MONTH_DAYS) {
  const [apps, nodes, day] = await Promise.all([
    prisma.application.findMany({ where: { organizationId }, select: { type: true, staticBucket: true, diskBytes: true } }),
    // a reading older than the gap the meter tolerates says nothing about now
    prisma.orgNode.findMany({ where: { organizationId, meterAt: { gte: new Date(Date.now() - MAX_INTERVAL_S * 1000) } }, select: { meterMemBytes: true, meterJournalBytes: true } }),
    prisma.usageHour.findMany({ where: { organizationId, hour: { gte: new Date(Date.now() - 24 * 3_600_000) } }, select: { cpuSeconds: true } }),
  ]);
  const sum = (list: typeof apps) => list.reduce((total, app) => total + Number(app.diskBytes ?? 0), 0) / GiB;
  const objectGb = sum(apps.filter(inObjectStorage));
  // its user's journal on each node (container logs, user services): disk too
  const journalGb = nodes.reduce((total, node) => total + Number(node.meterJournalBytes ?? 0), 0) / GiB;
  const storageGb = sum(apps.filter((app) => !inObjectStorage(app))) + journalGb;
  const memGb = nodes.reduce((sum, node) => sum + Number(node.meterMemBytes ?? 0), 0) / GiB;
  const cpuCores = day.length ? day.reduce((sum, h) => sum + h.cpuSeconds, 0) / (day.length * 3600) : 0;
  // an hour of each, priced
  const perHour = priceOf({ cpuSeconds: cpuCores * 3600, memGbSeconds: memGb * 3600, storageGbSeconds: storageGb * 3600, objectGbSeconds: objectGb * 3600 }, monthDays);
  return { storageGb, objectGb, journalGb, memGb, cpuCores, perHour: perHour.total };
}

const hourOf = (at: Date) => new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000);

/** The cron's run: read every provisioned workspace on every node, add what was used to this hour's rows. */
export async function meterUsage(): Promise<string> {
  const nodes = await prisma.orgNode.findMany({
    where: { state: 'DONE' },
    include: { organization: { select: { id: true, slug: true, uid: true } }, server: true },
  });
  const byServer = new Map<string, typeof nodes>();
  for (const node of nodes) byServer.set(node.serverId, [...(byServer.get(node.serverId) ?? []), node]);

  const at = new Date();
  const hour = hourOf(at);
  const added = new Map<string, { cpuSeconds: number; memGbSeconds: number; seconds: number }>();
  let failed = 0;

  for (const group of byServer.values()) {
    const server = group[0]!.server;
    let readings: Map<string, Reading>;
    try {
      const { stdout } = await execRoot(server, ['sh', '-c', meterScript(group.map((n) => n.organization))], { timeout: 60_000 });
      readings = parseMeter(stdout);
    } catch (error: any) {
      failed += 1;
      console.warn(`usage meter on ${server.name}: ${error?.stderr || error?.message || error}`);
      continue;
    }
    for (const node of group) {
      const now = readings.get(node.organizationId);
      if (!now) continue;
      const use = usageSince({ cpuUsec: node.meterCpuUsec, at: node.meterAt }, now, at);
      await prisma.orgNode.update({ where: { id: node.id }, data: { meterCpuUsec: now.cpuUsec, meterMemBytes: BigInt(now.memBytes), meterJournalBytes: BigInt(now.journalBytes), meterAt: at } });
      if (!use) continue;
      const sum = added.get(node.organizationId) ?? { cpuSeconds: 0, memGbSeconds: 0, seconds: 0 };
      added.set(node.organizationId, {
        cpuSeconds: sum.cpuSeconds + use.cpuSeconds,
        memGbSeconds: sum.memGbSeconds + use.memGbSeconds,
        // storage is the workspace's, not a node's: held for the longest interval seen
        seconds: Math.max(sum.seconds, use.seconds),
      });
    }
  }

  // what it stores: its services' measured size — on disk (folders, stacks) and in R2 (static sites), apart
  const stored = await prisma.application.findMany({
    where: { organizationId: { in: [...added.keys()] } },
    select: { organizationId: true, type: true, staticBucket: true, diskBytes: true },
  });
  const storageOf = new Map<string, { disk: number; object: number }>();
  // its journal on each node is disk it holds too
  for (const node of nodes) {
    const sum = storageOf.get(node.organizationId) ?? { disk: 0, object: 0 };
    sum.disk += Number(node.meterJournalBytes ?? 0);
    storageOf.set(node.organizationId, sum);
  }
  for (const app of stored) {
    const sum = storageOf.get(app.organizationId!) ?? { disk: 0, object: 0 };
    if (inObjectStorage(app)) sum.object += Number(app.diskBytes ?? 0);
    else sum.disk += Number(app.diskBytes ?? 0);
    storageOf.set(app.organizationId!, sum);
  }

  for (const [organizationId, use] of added) {
    const held = storageOf.get(organizationId) ?? { disk: 0, object: 0 };
    const storageGbSeconds = (held.disk / GiB) * use.seconds;
    const objectGbSeconds = (held.object / GiB) * use.seconds;
    await prisma.usageHour.upsert({
      where: { organizationId_hour: { organizationId, hour } },
      create: { organizationId, hour, cpuSeconds: use.cpuSeconds, memGbSeconds: use.memGbSeconds, storageGbSeconds, objectGbSeconds },
      update: {
        cpuSeconds: { increment: use.cpuSeconds },
        memGbSeconds: { increment: use.memGbSeconds },
        storageGbSeconds: { increment: storageGbSeconds },
        objectGbSeconds: { increment: objectGbSeconds },
      },
    });
  }
  return `${added.size} workspace(s) metered on ${byServer.size - failed}/${byServer.size} node(s)`;
}
