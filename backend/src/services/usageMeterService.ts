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

/** Per hour. From the plan prices: Rp 30k per vCPU-month, Rp 80k per GB-month of RAM, Rp 1.5k per GB-month of storage (730 h). */
// ponytail: constants — a superadmin-edited price list when prices start to change
export const RATES = {
  cpuCoreHour: 41,
  memGbHour: 110,
  storageGbHour: 2.05,
  currency: 'IDR',
} as const;

/**
 * Reads a unit's cgroup: CPU time used (µs, a counter) and memory now (bytes).
 * Straight from cgroupfs — present whatever systemd's accounting settings are.
 */
const CG = `cg() { p=$(systemctl show -p ControlGroup --value "$1" 2>/dev/null); d="/sys/fs/cgroup$p"; if [ -n "$p" ] && [ -d "$d" ]; then u=$(awk '/^usage_usec/{print $2}' "$d/cpu.stat" 2>/dev/null); m=$(cat "$d/memory.current" 2>/dev/null); echo "\${u:-0} \${m:-0}"; else echo "0 0"; fi; }`;

/** One line per workspace: `<orgId> <sliceUsec> <sliceMem> <podmanUsec> <podmanMem>`. Slugs are checked, uids are numbers. */
export function meterScript(orgs: Array<{ id: string; slug: string; uid: number | null }>): string {
  const lines = orgs
    .filter((org) => ORG_SLUG_RE.test(org.slug) && /^[a-z0-9]+$/.test(org.id))
    .map((org) => `echo "${org.id} $(cg cb-${org.slug}.slice) $(${org.uid ? `cg user@${Number(org.uid)}.service` : 'echo 0 0'})"`);
  return [CG, ...lines].join('\n');
}

export type Reading = { cpuUsec: bigint; memBytes: number };

/** Parse meterScript's output. Pure. */
export function parseMeter(stdout: string): Map<string, Reading> {
  const out = new Map<string, Reading>();
  for (const line of stdout.split('\n')) {
    const [id, u1, m1, u2, m2] = line.trim().split(/\s+/);
    if (!id || u1 === undefined) continue;
    const big = (v?: string) => (v && /^\d+$/.test(v) ? BigInt(v) : 0n);
    const num = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : 0);
    out.set(id, { cpuUsec: big(u1) + big(u2), memBytes: num(m1) + num(m2) });
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

/** Rupiah for an amount of use. Pure. */
export function priceOf(use: { cpuSeconds: number; memGbSeconds: number; storageGbSeconds: number }) {
  const cpu = (use.cpuSeconds / 3600) * RATES.cpuCoreHour;
  const mem = (use.memGbSeconds / 3600) * RATES.memGbHour;
  const storage = (use.storageGbSeconds / 3600) * RATES.storageGbHour;
  return { cpu, mem, storage, total: cpu + mem + storage };
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
      await prisma.orgNode.update({ where: { id: node.id }, data: { meterCpuUsec: now.cpuUsec, meterAt: at } });
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

  // what it stores: its services' measured size (their folders, stacks, R2 files)
  const storage = await prisma.application.groupBy({
    by: ['organizationId'],
    where: { organizationId: { in: [...added.keys()] } },
    _sum: { diskBytes: true },
  });
  const storageOf = new Map(storage.map((row) => [row.organizationId, Number(row._sum.diskBytes ?? 0)]));

  for (const [organizationId, use] of added) {
    const storageGbSeconds = ((storageOf.get(organizationId) ?? 0) / GiB) * use.seconds;
    await prisma.usageHour.upsert({
      where: { organizationId_hour: { organizationId, hour } },
      create: { organizationId, hour, cpuSeconds: use.cpuSeconds, memGbSeconds: use.memGbSeconds, storageGbSeconds },
      update: {
        cpuSeconds: { increment: use.cpuSeconds },
        memGbSeconds: { increment: use.memGbSeconds },
        storageGbSeconds: { increment: storageGbSeconds },
      },
    });
  }
  return `${added.size} workspace(s) metered on ${byServer.size - failed}/${byServer.size} node(s)`;
}
