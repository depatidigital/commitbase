import { prisma } from '../lib/prisma';

/**
 * Check history for the things the platform watches.
 *
 * The checks themselves already existed — an app's hostname, a node's SSH
 * reachability, a port's listener — but each answer was thrown away the moment
 * it was read. That answers "is it up?" and nothing else: not whether it has
 * been flapping, not when it broke, not what it looked like before the deploy.
 *
 * So every check writes a beat here, and the UI draws bars and uptime from
 * them. Nothing new is polled: the same cron jobs that were already visiting
 * every node now record what they saw.
 */

export type TargetType = 'APPLICATION' | 'SERVER';

/**
 * How long raw beats are kept.
 *
 * At a beat a minute per application this is the whole storage cost: 50 apps is
 * ~72k rows a day. A week feeds the bars and every uptime window anyone reads
 * off this screen.
 * ponytail: raw only, no rollups. Add an hourly aggregate table if 30- or
 * 90-day uptime is ever asked for — that is the point where raw stops paying.
 */
const RETENTION_DAYS = Number(process.env.HEARTBEAT_RETENTION_DAYS || 7);

/**
 * Consecutive failures before a target is called down.
 *
 * One missed check is a blip: a restart, a slow DNS answer, a node under load.
 * Treating it as an outage is how a status page trains people to ignore it.
 */
export const FAIL_THRESHOLD = 2;

export type BeatInput = {
  targetType: TargetType;
  targetId: string;
  ok: boolean;
  responseMs?: number | null;
  httpStatus?: number | null;
  error?: string | null;
};

/** Record one check result. Never throws: a failed write must not fail the check. */
export async function recordBeat(beat: BeatInput): Promise<void> {
  try {
    await prisma.heartbeat.create({
      data: {
        targetType: beat.targetType,
        targetId: beat.targetId,
        ok: beat.ok,
        responseMs: beat.responseMs ?? null,
        httpStatus: beat.httpStatus ?? null,
        error: beat.error ? String(beat.error).slice(0, 500) : null,
      },
    });
  } catch (error: any) {
    console.error('Could not record heartbeat:', error?.message);
  }
}

/** Record a batch — one round of checks over many targets. */
export async function recordBeats(beats: BeatInput[]): Promise<void> {
  if (beats.length === 0) return;

  try {
    await prisma.heartbeat.createMany({
      data: beats.map((beat) => ({
        targetType: beat.targetType,
        targetId: beat.targetId,
        ok: beat.ok,
        responseMs: beat.responseMs ?? null,
        httpStatus: beat.httpStatus ?? null,
        error: beat.error ? String(beat.error).slice(0, 500) : null,
      })),
    });
  } catch (error: any) {
    console.error('Could not record heartbeats:', error?.message);
  }
}

export type Beat = {
  at: Date;
  ok: boolean;
  responseMs: number | null;
  httpStatus: number | null;
  error: string | null;
};

export type Health = {
  /** up, down, or pending — failing, but not yet past the threshold. */
  state: 'up' | 'down' | 'pending' | 'unknown';
  beats: Beat[];
  /** Percentage of successful beats in the last 24 hours, or null with no data. */
  uptime24h: number | null;
  lastError: string | null;
  responseMs: number | null;
};

const EMPTY: Health = {
  state: 'unknown',
  beats: [],
  uptime24h: null,
  lastError: null,
  responseMs: null,
};

/**
 * Health for many targets at once, for a table that renders a bar per row.
 * One query for the beats and one for the day's totals, however many rows.
 */
export async function healthFor(
  targetType: TargetType,
  targetIds: string[],
  barCount = 30,
): Promise<Record<string, Health>> {
  const result: Record<string, Health> = {};
  if (targetIds.length === 0) return result;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Enough rows to fill every row's bar. Fetched flat and grouped in memory:
  // "the newest N per target" is a lateral join in SQL and a filter here.
  const rows = await prisma.heartbeat.findMany({
    where: { targetType, targetId: { in: targetIds } },
    orderBy: { at: 'desc' },
    take: targetIds.length * barCount,
    select: { targetId: true, at: true, ok: true, responseMs: true, httpStatus: true, error: true },
  });

  const grouped = new Map<string, Beat[]>();
  for (const row of rows) {
    const beats = grouped.get(row.targetId) ?? [];
    if (beats.length < barCount) {
      beats.push({
        at: row.at,
        ok: row.ok,
        responseMs: row.responseMs,
        httpStatus: row.httpStatus,
        error: row.error,
      });
      grouped.set(row.targetId, beats);
    }
  }

  const totals = await prisma.heartbeat.groupBy({
    by: ['targetId', 'ok'],
    where: { targetType, targetId: { in: targetIds }, at: { gte: since } },
    _count: { _all: true },
  });

  const dayCounts = new Map<string, { ok: number; total: number }>();
  for (const row of totals) {
    const counts = dayCounts.get(row.targetId) ?? { ok: 0, total: 0 };
    counts.total += row._count._all;
    if (row.ok) counts.ok += row._count._all;
    dayCounts.set(row.targetId, counts);
  }

  for (const id of targetIds) {
    // newest first, which is also the order the bar is drawn in reverse
    const beats = grouped.get(id) ?? [];
    const counts = dayCounts.get(id);

    if (beats.length === 0) {
      result[id] = EMPTY;
      continue;
    }

    // how many of the most recent checks failed in a row
    let consecutiveFailures = 0;
    for (const beat of beats) {
      if (beat.ok) break;
      consecutiveFailures += 1;
    }

    result[id] = {
      state:
        consecutiveFailures === 0
          ? 'up'
          : consecutiveFailures >= FAIL_THRESHOLD
            ? 'down'
            : 'pending',
      beats,
      uptime24h: counts && counts.total > 0 ? Math.round((counts.ok / counts.total) * 1000) / 10 : null,
      lastError: beats.find((beat) => !beat.ok)?.error ?? null,
      responseMs: beats[0]?.responseMs ?? null,
    };
  }

  return result;
}

/** Drop beats past the retention window. Returns how many went. */
export async function pruneHeartbeats(): Promise<number> {
  const { count } = await prisma.heartbeat.deleteMany({
    where: { at: { lt: new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000) } },
  });
  return count;
}

/**
 * Check every application's hostname and record what came back.
 *
 * Deliberately separate from the inventory sync: this needs no SSH — it opens a
 * TLS connection from the control plane — so it can run every minute, where the
 * inventory (pm2, ss, the Caddy config) cannot. That difference is what makes
 * the bars mean something: a minute of resolution instead of ten.
 */
export async function checkApplicationHostnames(): Promise<string> {
  const { checkAppHostname } = await import('./appDnsService');

  const apps = await prisma.application.findMany({
    // a hostname that only exists inside the platform has nothing to check
    where: { domain: { not: { endsWith: '.pm2.local' } } },
    select: { id: true, domain: true },
  });

  if (apps.length === 0) return 'no applications to check';

  const beats: BeatInput[] = [];
  const CONCURRENCY = 10;

  // A slice at a time: fifty simultaneous TLS handshakes is a burst the node
  // sees as a small flood, and the results are needed together anyway.
  for (let i = 0; i < apps.length; i += CONCURRENCY) {
    const slice = apps.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (app) => {
        const startedAt = Date.now();
        const health = await checkAppHostname(app.domain);
        return { app, health, ms: Date.now() - startedAt };
      }),
    );

    for (const { app, health, ms } of results) {
      beats.push({
        targetType: 'APPLICATION',
        targetId: app.id,
        ok: health.live,
        responseMs: ms,
        httpStatus: health.httpStatus,
        error: health.live ? null : health.error,
      });
    }
  }

  await recordBeats(beats);
  const up = beats.filter((beat) => beat.ok).length;
  return `${up}/${beats.length} answering`;
}
