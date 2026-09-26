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
/** the meter's own rhythm, with room: a reading older than this is a gap */
const MAX_INTERVAL_S = 15 * 60;
/**
 * A gap (the backend was down) is billed at the lower of the readings either
 * side of it — never more than was held at both ends — for up to this long;
 * past it nothing is known about the memory, so nothing more is billed.
 */
const MAX_GAP_FILL_S = 6 * 3600;

/** Days are Jakarta's (WIB, UTC+7): what a customer calls "today". */
export const WIB_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
/** 00:00 WIB of the day `at` falls in, as a UTC instant. */
export const wibDayStart = (at: number) => Math.floor((at + WIB_MS) / DAY_MS) * DAY_MS - WIB_MS;
const hourOf = (at: Date) => new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000);

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

/**
 * WhatsApp Gateway API, per number: a day it was linked, texts past the free
 * ones a day, and media; a customer's own WA node by the month. Not metered
 * yet — the Pricing page shows them.
 */
export const WA_RATES = {
  linkedDay: 400,
  freeTextsPerDay: 200,
  textAfterFree: 5,
  media: 5,
  ownNodeMonth: 5000,
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

/**
 * The meter lives on each node: a systemd timer samples every workspace every
 * five minutes into /var/lib/larika/meter.log, whether the panel is up or not.
 * The panel only collects what was written since it last looked — a panel that
 * was down a day loses nothing, memory included, and a node's last sample before
 * a reboot is on its disk.
 *
 * Line: `<epoch> <slug> <sliceUsec> <sliceMem> <podmanUsec> <podmanMem> <journalBytes>`.
 * Which workspaces to sample the panel writes to meter.orgs (`<slug> <uid>`),
 * checked on both ends. Bump METER_VERSION to reinstall the sampler everywhere.
 */
const METER_VERSION = '1';

const SAMPLER = `#!/bin/sh
# larika-meter v${METER_VERSION}: one line per workspace, appended to /var/lib/larika/meter.log
${CG}
${JR}
D=/var/lib/larika
[ -f "$D/meter.orgs" ] || exit 0
now=$(date +%s)
while read -r slug uid; do
  case "$slug" in ''|*[!a-z0-9-]*) continue;; esac
  case "$uid" in *[!0-9]*) uid=;; esac
  if [ -n "$uid" ]; then p=$(cg "user@$uid.service"); j=$(jr "$uid"); else p="0 0"; j=0; fi
  echo "$now $slug $(cg "cb-$slug.slice") $p \${j:-0}"
done < "$D/meter.orgs" >> "$D/meter.log"
# about a week of samples for a few dozen workspaces
n=$(wc -l < "$D/meter.log")
if [ "$n" -gt 60000 ]; then tail -n 50000 "$D/meter.log" > "$D/meter.log.tmp" && mv "$D/meter.log.tmp" "$D/meter.log"; fi
exit 0`;

const SERVICE = `[Unit]
Description=Larika usage meter
[Service]
Type=oneshot
ExecStart=/bin/sh /usr/local/lib/larika-meter.sh`;

const TIMER = `[Unit]
Description=Larika usage meter, every five minutes
[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
AccuracySec=10s
[Install]
WantedBy=timers.target`;

/**
 * What the panel runs as root on a node: install (or upgrade) the sampler and
 * its timer, name the workspaces to sample, take a sample now, and print every
 * line written after $1 (an epoch). Fixed text; the workspaces come as
 * arguments (`<slug>:<uid>`), checked again here.
 */
export const COLLECT_SCRIPT = `set -e
if ! grep -q "larika-meter v${METER_VERSION}:" /usr/local/lib/larika-meter.sh 2>/dev/null; then
  mkdir -p /usr/local/lib
  cat > /usr/local/lib/larika-meter.sh <<'LARIKA_EOF'
${SAMPLER}
LARIKA_EOF
  cat > /etc/systemd/system/larika-meter.service <<'LARIKA_EOF'
${SERVICE}
LARIKA_EOF
  cat > /etc/systemd/system/larika-meter.timer <<'LARIKA_EOF'
${TIMER}
LARIKA_EOF
  systemctl daemon-reload
  systemctl enable --now larika-meter.timer >/dev/null 2>&1 || true
fi
mkdir -p /var/lib/larika
since="$1"; shift
case "$since" in ''|*[!0-9]*) since=0;; esac
: > /var/lib/larika/meter.orgs.tmp
for o in "$@"; do
  slug=\${o%%:*}; uid=\${o#*:}
  case "$slug" in ''|*[!a-z0-9-]*) continue;; esac
  case "$uid" in *[!0-9]*) uid=;; esac
  echo "$slug $uid" >> /var/lib/larika/meter.orgs.tmp
done
mv /var/lib/larika/meter.orgs.tmp /var/lib/larika/meter.orgs
/bin/sh /usr/local/lib/larika-meter.sh
touch /var/lib/larika/meter.log
awk -v t="$since" '$1 > t' /var/lib/larika/meter.log`;

/** The arguments COLLECT_SCRIPT takes after the epoch: safe slugs, numeric uids. */
export function meterOrgArgs(orgs: Array<{ slug: string; uid: number | null }>): string[] {
  return orgs.filter((org) => ORG_SLUG_RE.test(org.slug)).map((org) => `${org.slug}:${org.uid ? Number(org.uid) : ''}`);
}

export type Reading = { cpuUsec: bigint; memBytes: number; journalBytes: number };
export type Sample = Reading & { at: Date };

/** Parse the meter log: each workspace's samples, oldest first. Pure. */
export function parseMeterLog(stdout: string): Map<string, Sample[]> {
  const out = new Map<string, Sample[]>();
  const big = (v?: string) => (v && /^\d+$/.test(v) ? BigInt(v) : 0n);
  const num = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : 0);
  for (const line of stdout.split('\n')) {
    const [epoch, slug, u1, m1, u2, m2, j] = line.trim().split(/\s+/);
    if (!epoch || !/^\d+$/.test(epoch) || !slug || u1 === undefined) continue;
    const list = out.get(slug) ?? [];
    list.push({ at: new Date(Number(epoch) * 1000), cpuUsec: big(u1) + big(u2), memBytes: num(m1) + num(m2), journalBytes: num(j) });
    out.set(slug, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.at.getTime() - b.at.getTime());
  return out;
}

/**
 * What was used since the last reading. Pure.
 *
 * CPU is the kernel's counter, so a gap loses nothing: it all shows in the
 * delta — spread over the gap's whole span. The counter restarts from zero when
 * the slice does (a reboot, a re-provision): then all of it is new.
 *
 * Memory is only ever a reading. A normal interval bills this one for its
 * length; a gap bills the lower of the two readings, up to MAX_GAP_FILL_S —
 * the last part of the gap, the hours nearest what was read.
 *
 * No previous reading: nothing yet — the next one has a delta.
 */
export function usageSince(
  prev: { cpuUsec: bigint | null; memBytes: bigint | null; at: Date | null },
  now: Reading,
  at: Date,
): { cpuSeconds: number; cpuFrom: Date; memGbSeconds: number; memFrom: Date } | null {
  if (prev.cpuUsec === null || !prev.at) return null;
  const gap = Math.max(0, (at.getTime() - prev.at.getTime()) / 1000);
  const cpuUsec = now.cpuUsec >= prev.cpuUsec ? now.cpuUsec - prev.cpuUsec : now.cpuUsec;
  const gapped = gap > MAX_INTERVAL_S;
  const memSeconds = gapped ? Math.min(gap, MAX_GAP_FILL_S) : gap;
  const memBytes = gapped ? Math.min(now.memBytes, Number(prev.memBytes ?? now.memBytes)) : now.memBytes;
  return {
    cpuSeconds: Number(cpuUsec) / 1e6,
    cpuFrom: prev.at,
    memGbSeconds: (memBytes / GiB) * memSeconds,
    memFrom: new Date(at.getTime() - memSeconds * 1000),
  };
}

/** Each hour [from, to) touches, with its share of the span. Pure. */
export function spreadHours(from: Date, to: Date): Array<{ hour: Date; share: number }> {
  const span = to.getTime() - from.getTime();
  if (span <= 0) return [{ hour: hourOf(to), share: 1 }];
  const out: Array<{ hour: Date; share: number }> = [];
  for (let h = hourOf(from).getTime(); h < to.getTime(); h += 3_600_000) {
    const overlap = Math.min(h + 3_600_000, to.getTime()) - Math.max(h, from.getTime());
    if (overlap > 0) out.push({ hour: new Date(h), share: overlap / span });
  }
  return out;
}

export type Held = { diskBytes: number; journalBytes: number; objectBytes: number };

/**
 * What a workspace held on average over [from, to), from the sizes known now: a
 * service counts from when it was made. Pure. For a day nothing was read on —
 * before metering began, or a gap.
 */
export function heldBetween(
  apps: Array<{ createdAt: Date; diskBytes: bigint | number | null; type: string; staticBucket: string | null }>,
  journal: { bytes: number; since: Date },
  from: number,
  to: number,
): Held {
  const share = (since: number) => (to > from ? Math.max(0, to - Math.max(from, since)) / (to - from) : 0);
  const held: Held = { diskBytes: 0, journalBytes: journal.bytes * share(journal.since.getTime()), objectBytes: 0 };
  for (const app of apps) {
    const bytes = Number(app.diskBytes ?? 0) * share(app.createdAt.getTime());
    if (inObjectStorage(app)) held.objectBytes += bytes;
    else held.diskBytes += bytes;
  }
  return held;
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

/** The cron's run: read every provisioned workspace on every node, add what was used to its hours' rows, and today's storage. */
export async function meterUsage(): Promise<string> {
  const nodes = await prisma.orgNode.findMany({
    where: { state: 'DONE' },
    include: { organization: { select: { id: true, slug: true, uid: true } }, server: true },
  });
  const byServer = new Map<string, typeof nodes>();
  for (const node of nodes) byServer.set(node.serverId, [...(byServer.get(node.serverId) ?? []), node]);

  const at = new Date();
  // per workspace, per hour: what the readings add — a gap's CPU spread over its hours
  const added = new Map<string, Map<number, { cpuSeconds: number; memGbSeconds: number }>>();
  const add = (organizationId: string, from: Date, to: Date, field: 'cpuSeconds' | 'memGbSeconds', amount: number) => {
    const hours = added.get(organizationId) ?? new Map<number, { cpuSeconds: number; memGbSeconds: number }>();
    for (const { hour, share } of spreadHours(from, to)) {
      const sum = hours.get(hour.getTime()) ?? { cpuSeconds: 0, memGbSeconds: 0 };
      sum[field] += amount * share;
      hours.set(hour.getTime(), sum);
    }
    added.set(organizationId, hours);
  };
  // each workspace read on at least one node, with its journal summed over them
  const journalOf = new Map<string, number>();
  let failed = 0;

  for (const group of byServer.values()) {
    const server = group[0]!.server;
    // what the node wrote since the panel last looked — the oldest cursor of the workspaces on it,
    // or the last quarter hour for one never read (its first sample is only a starting point)
    const since = Math.min(...group.map((node) => (node.meterAt ?? new Date(at.getTime() - MAX_INTERVAL_S * 1000)).getTime()));
    let samples: Map<string, Sample[]>;
    try {
      const { stdout } = await execRoot(
        server,
        ['sh', '-c', COLLECT_SCRIPT, 'sh', String(Math.floor(since / 1000)), ...meterOrgArgs(group.map((n) => n.organization))],
        { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
      );
      samples = parseMeterLog(stdout);
    } catch (error: any) {
      failed += 1;
      console.warn(`usage meter on ${server.name}: ${error?.stderr || error?.message || error}`);
      continue;
    }
    for (const node of group) {
      // this workspace's samples it has not taken yet, in order; a new one starts from its latest
      const all = (samples.get(node.organization.slug) ?? []).filter((s) => !node.meterAt || s.at > node.meterAt);
      const fresh = node.meterAt ? all : all.slice(-1);
      if (!fresh.length) continue;
      let prev = { cpuUsec: node.meterCpuUsec, memBytes: node.meterMemBytes, at: node.meterAt };
      for (const sample of fresh) {
        const use = usageSince(prev, sample, sample.at);
        if (use) {
          add(node.organizationId, use.cpuFrom, sample.at, 'cpuSeconds', use.cpuSeconds);
          add(node.organizationId, use.memFrom, sample.at, 'memGbSeconds', use.memGbSeconds);
        }
        prev = { cpuUsec: sample.cpuUsec, memBytes: BigInt(sample.memBytes), at: sample.at };
      }
      const last = fresh[fresh.length - 1]!;
      journalOf.set(node.organizationId, (journalOf.get(node.organizationId) ?? 0) + last.journalBytes);
      await prisma.orgNode.update({
        where: { id: node.id },
        data: { meterCpuUsec: last.cpuUsec, meterMemBytes: BigInt(last.memBytes), meterJournalBytes: BigInt(last.journalBytes), meterAt: last.at },
      });
    }
  }

  for (const [organizationId, hours] of added) {
    for (const [hour, use] of hours) {
      await prisma.usageHour.upsert({
        where: { organizationId_hour: { organizationId, hour: new Date(hour) } },
        create: { organizationId, hour: new Date(hour), ...use },
        update: { cpuSeconds: { increment: use.cpuSeconds }, memGbSeconds: { increment: use.memGbSeconds } },
      });
    }
  }

  // what it stores today — its services' measured sizes (on disk, in R2) and its journal — kept at the day's largest
  const stored = await prisma.application.findMany({
    where: { organizationId: { in: [...journalOf.keys()] } },
    select: { organizationId: true, type: true, staticBucket: true, diskBytes: true },
  });
  const day = new Date(wibDayStart(at.getTime()));
  for (const [organizationId, journalBytes] of journalOf) {
    let diskBytes = 0;
    let objectBytes = 0;
    for (const app of stored) {
      if (app.organizationId !== organizationId) continue;
      if (inObjectStorage(app)) objectBytes += Number(app.diskBytes ?? 0);
      else diskBytes += Number(app.diskBytes ?? 0);
    }
    await prisma.$executeRaw`
      INSERT INTO "storage_days" ("organizationId", "day", "diskBytes", "journalBytes", "objectBytes", "backfilled")
      VALUES (${organizationId}, ${day}, ${BigInt(diskBytes)}, ${BigInt(journalBytes)}, ${BigInt(objectBytes)}, false)
      ON CONFLICT ("organizationId", "day") DO UPDATE SET
        "diskBytes" = GREATEST("storage_days"."diskBytes", EXCLUDED."diskBytes"),
        "journalBytes" = GREATEST("storage_days"."journalBytes", EXCLUDED."journalBytes"),
        "objectBytes" = GREATEST("storage_days"."objectBytes", EXCLUDED."objectBytes"),
        "backfilled" = false`;
  }
  return `${added.size} workspace(s) metered on ${byServer.size - failed}/${byServer.size} node(s)`;
}

/**
 * Every day a workspace had services but nothing was read — before metering
 * began, or a gap — written from the sizes known now, each service from the
 * moment it was made. Up to yesterday: today is the meter's. Written once, so a
 * past day's bill does not move with later growth or cleanups.
 */
export async function backfillStorageDays(organizationId?: string): Promise<string> {
  const orgs = await prisma.organization.findMany({
    where: organizationId ? { id: organizationId } : {},
    select: {
      id: true,
      createdAt: true,
      applications: { select: { createdAt: true, diskBytes: true, type: true, staticBucket: true } },
      nodes: { select: { meterJournalBytes: true } },
      storageDays: { select: { day: true } },
    },
  });
  const today = wibDayStart(Date.now());
  let written = 0;
  for (const org of orgs) {
    if (!org.applications.length) continue;
    const have = new Set(org.storageDays.map((row) => row.day.getTime()));
    const journal = { bytes: org.nodes.reduce((sum, node) => sum + Number(node.meterJournalBytes ?? 0), 0), since: org.createdAt };
    const first = wibDayStart(Math.min(...org.applications.map((app) => app.createdAt.getTime())));
    const rows = [];
    for (let day = first; day < today; day += DAY_MS) {
      if (have.has(day)) continue;
      const held = heldBetween(org.applications, journal, day, day + DAY_MS);
      rows.push({
        organizationId: org.id,
        day: new Date(day),
        diskBytes: BigInt(Math.round(held.diskBytes)),
        journalBytes: BigInt(Math.round(held.journalBytes)),
        objectBytes: BigInt(Math.round(held.objectBytes)),
        backfilled: true,
      });
    }
    if (rows.length) written += (await prisma.storageDay.createMany({ data: rows, skipDuplicates: true })).count;
  }
  return `${written} storage day(s) backfilled`;
}
