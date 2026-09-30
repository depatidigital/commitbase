import { prisma } from '../lib/prisma';
import { sourceFsFor, type AppFs } from '../lib/appFs';
import { currentDirFor, logsDirFor, releasesDirFor, sharedDirFor } from '../lib/appPaths';
import { exec, execRoot, type SshTarget } from '../lib/runner';
import { listPm2Processes } from './appSyncService';
import { serverForApplication } from '../lib/servers';
import { listSiteObjects } from './r2Service';
import { removeAppTree } from './orgProvisionService';
import { stackUsage, type StackUsage } from './composeService';
import * as path from 'path';

const join = path.posix.join;

/**
 * What an app's tree on its node costs, and giving the unused part back.
 *
 * A release is `live` (what `current` points at), `rollback` (a READY build
 * kept so a bad deploy can be undone without rebuilding) or `unused` — left
 * by builds that failed, were cancelled, or fell out of the rollback window.
 * Only `unused` is ever removed; the live release never is.
 */

/** Successful releases kept per app, the live one included. 1 = no rollback. */
export const KEEP_RELEASES = Math.max(1, Number(process.env.KEEP_RELEASES) || 2);

export type ReleaseState = 'live' | 'rollback' | 'unused';

export interface AppDisk {
  releases: Array<{ name: string; bytes: number; state: ReleaseState }>;
  /** the live release by top-level entry (node_modules, .next, …), biggest first */
  liveParts: Array<{ name: string; bytes: number }>;
  /** of the live release, files with other hardlinks (pnpm's store, the previous release): counted in it, stored once */
  liveSharedBytes: number;
  /** Next.js build cache, shared by every release — rebuilt on the next build if removed */
  cacheBytes: number;
  logsBytes: number;
  sourcesBytes: number;
  /** a compose app's stack in its org's Podman — images, containers, volumes; null for others, or before it ran */
  stack: StackUsage | null;
  /** imported (pm2, Caddy files — someone else's): its folder is sourcesBytes, its pm2 logs logsBytes; nothing of it is the panel's to clean */
  imported?: boolean;
  totalBytes: number;
  /** what cleaning up (without the cache) would give back */
  reclaimableBytes: number;
}

/**
 * Sizes in bytes, from one `du` call — so a file hardlinked into several
 * releases (node_modules while the lockfile is unchanged) is counted once, at
 * the first path listed. Listing the live release first charges it the shared
 * part, and every other release only what it adds. Missing paths count 0.
 */
async function sizes(afs: AppFs, paths: string[]): Promise<Map<string, number>> {
  const out = new Map(paths.map((p) => [p, 0]));
  if (paths.length === 0) return out;
  const { stdout } = await afs.run(['sh', '-c', 'du -sb -- "$@" 2>/dev/null; true', 'sh', ...paths], { timeout: 300_000 });
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab > 0) out.set(line.slice(tab + 1), Number(line.slice(0, tab)) || 0);
  }
  return out;
}

/**
 * The live release ($1) by top-level entry, then "--", then the bytes of its
 * files that have other hardlinks, each inode once. Positional args only.
 */
export const PARTS_DU =
  `cd -- "$1" 2>/dev/null || exit 0; du -sb -- * .[!.]* 2>/dev/null; echo --; ` +
  `find . -type f -links +1 -printf '%i %s\\n' 2>/dev/null | awk '!seen[$1]++ {s+=$2} END{print s+0}'`;

/** Parses PARTS_DU's output. Pure. */
export function parseParts(stdout: string): { parts: Array<{ name: string; bytes: number }>; shared: number } {
  const [du = '', shared = '0'] = stdout.split(/^--$/m);
  const parts = du
    .split('\n')
    .map((line) => ({ bytes: Number(line.split('\t')[0]) || 0, name: line.slice(line.indexOf('\t') + 1) }))
    .filter((part) => part.name && part.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  return { parts, shared: Number(shared.trim()) || 0 };
}

/** Every release directory with its state, the live one first. */
async function releasesOf(afs: AppFs, applicationId: string, keep: number) {
  const dir = releasesDirFor(afs.appDir);
  const current = await afs.readlink(currentDirFor(afs.appDir)).catch(() => null);
  const ready = await prisma.release.findMany({
    where: { applicationId, status: 'READY', path: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, path: true },
  });
  // the newest READY ones (not counting live) fill the rest of the window
  const rollback = new Set(ready.filter((r) => r.path !== current).slice(0, Math.max(0, keep - 1)).map((r) => r.path!));

  const names = (await afs.readdir(dir).catch(() => [] as string[])).sort().reverse();
  const releases = names.map((name) => {
    const full = join(dir, name);
    const state: ReleaseState = full === current ? 'live' : rollback.has(full) ? 'rollback' : 'unused';
    return { name, path: full, state };
  });
  releases.sort((a, b) => Number(b.state === 'live') - Number(a.state === 'live'));
  return { releases, ready };
}

/**
 * The disk use of the app's tree on its node. Null for a static site — its files are in R2.
 * withParts: also what the live release is made of — a second walk of it, so only for the storage card. */
export async function appDiskUsage(applicationId: string, keep = KEEP_RELEASES, withParts = false): Promise<AppDisk | null> {
  const app = await prisma.application.findUnique({ where: { id: applicationId }, include: { organization: { select: { slug: true } } } });
  if (!app) return null;
  if (app.runtime) return importedDisk(app);
  if (app.type === 'STATIC') return null;
  const afs = await sourceFsFor(applicationId);

  const { releases } = await releasesOf(afs, applicationId, keep);
  const cache = join(sharedDirFor(afs.appDir), 'next-cache');
  const logs = logsDirFor(afs.appDir);
  const sources = afs.sourcesDir;
  const measured = await sizes(afs, [...releases.map((r) => r.path), cache, sources, logs]);

  const rows = releases.map((r) => ({ name: r.name, bytes: measured.get(r.path) ?? 0, state: r.state }));
  const cacheBytes = measured.get(cache) ?? 0;
  const logsBytes = measured.get(logs) ?? 0;
  const sourcesBytes = measured.get(sources) ?? 0;
  // most of a compose app lives outside its folder: what its stack takes in Podman. A node that cannot say leaves it out
  const stack = app.type === 'COMPOSE' ? await stackUsage(app).catch(() => null) : null;
  const live = releases.find((r) => r.state === 'live');
  const { parts, shared } = live && withParts
    ? parseParts((await afs.run(['sh', '-c', PARTS_DU, 'sh', live.path], { timeout: 300_000 }).catch(() => ({ stdout: '' }))).stdout)
    : { parts: [], shared: 0 };
  const stackBytes = stack ? stack.imagesBytes + stack.containersBytes + stack.volumesBytes + stack.logsBytes : 0;
  return {
    releases: rows,
    liveParts: parts,
    liveSharedBytes: shared,
    cacheBytes,
    logsBytes,
    sourcesBytes,
    stack,
    totalBytes: rows.reduce((sum, r) => sum + r.bytes, 0) + cacheBytes + logsBytes + sourcesBytes + stackBytes,
    reclaimableBytes: rows.filter((r) => r.state === 'unused').reduce((sum, r) => sum + r.bytes, 0),
  };
}

/**
 * The folder ($1), then its pm2 logs ($2…): the paths pm2 itself says it writes
 * to, and the copies pm2-logrotate keeps beside each (<name>__<date>.log) — the
 * ones outside the folder; those inside are in its du already.
 * Positional args only — no path is ever spliced into the script.
 */
export const IMPORTED_DU =
  // a folder that is gone says so: 0 bytes would read as "measured, empty"
  `[ -e "$1" ] || { echo missing; exit 0; }; ` +
  `du -sb -- "$1" 2>/dev/null | cut -f1; root="$1"; shift; t=0; ` +
  // a log inside the folder is in its du already: counted once
  `for p in "$@"; do case "$p" in "$root"/*) continue ;; esac; d=$(dirname -- "$p"); b=$(basename -- "$p"); s=\${b%.log}; ` +
  `n=$(find "$d" -maxdepth 1 -type f \\( -name "$b" -o -name "\${s}__*" \\) -printf '%s\\n' 2>/dev/null | awk '{s+=$1} END{print s+0}'); ` +
  `t=$((t + n)); done; echo "$t"`;

/** An imported service's folder on its node and its pm2 logs. As root: the folder and the logs are other users'. */
async function importedDisk(app: { id: string; rootPath: string | null; processName: string | null; runtime: string | null }): Promise<AppDisk | null> {
  // said, not guessed at: nothing measured is not the same as nothing stored
  if (!app.rootPath?.startsWith('/')) throw new Error('Its folder on the server is not known — Sync Apps finds it');
  const node = await serverForApplication(app.id);
  // where pm2 says this process logs to; not pm2's (Caddy files): no logs of its own
  const logPaths =
    app.runtime === 'PM2' && app.processName
      ? (await listPm2Processes(node)).find((process) => process.name === app.processName)?.logPaths ?? []
      : [];
  const { stdout } = await execRoot(node, ['sh', '-c', IMPORTED_DU, 'sh', app.rootPath, ...logPaths], { timeout: 300_000 });
  if (stdout.trim() === 'missing') throw new Error(`${app.rootPath} is not on the server anymore — Sync Apps finds where it went`);
  const [folder = '0', logs = '0'] = stdout.trim().split('\n');
  const sourcesBytes = Number(folder) || 0;
  const logsBytes = Number(logs) || 0;
  return { releases: [], liveParts: [], liveSharedBytes: 0, cacheBytes: 0, logsBytes, sourcesBytes, stack: null, imported: true, totalBytes: sourcesBytes + logsBytes, reclaimableBytes: 0 };
}

/**
 * Remove the unused releases (and, asked for, the Next build cache). A READY
 * release whose tree goes loses its row too, so the Releases card never
 * offers a rollback to a directory that is gone. Returns what went.
 */
export async function cleanupAppReleases(
  afs: AppFs,
  applicationId: string,
  { keep = KEEP_RELEASES, cache = false }: { keep?: number; cache?: boolean } = {},
): Promise<{ removed: string[] }> {
  const { releases, ready } = await releasesOf(afs, applicationId, keep);
  const slug = (await prisma.application.findUnique({ where: { id: applicationId }, select: { organization: { select: { slug: true } } } }))?.organization?.slug;
  const removed: string[] = [];
  for (const release of releases) {
    if (release.state !== 'unused') continue;
    // as root on the node: the tree is the build user's, the SSH user cannot delete through it.
    // said, not thrown: one tree that will not go must not stop the rest
    const gone = slug
      ? removeAppTree(slug, applicationId, `releases/${release.name}`)
      : afs.rm(release.path, { recursive: true, force: false });
    const ok = await gone.then(() => true, (error: any) => {
      console.warn(`cleanup ${applicationId}: ${release.name} not removed: ${error?.stderr || error?.message || error}`);
      return false;
    });
    if (ok) removed.push(release.name);
  }
  const gone = new Set(releases.filter((r) => r.state === 'unused' && removed.includes(r.name)).map((r) => r.path));
  const staleRows = ready.filter((r) => gone.has(r.path!)).map((r) => r.id);
  // never the active one: it is `live`, so its tree is not in `gone`
  if (staleRows.length) await prisma.release.deleteMany({ where: { id: { in: staleRows } } });

  if (cache) {
    await afs.rm(join(sharedDirFor(afs.appDir), 'next-cache'), { recursive: true, force: true }).catch(() => {});
    removed.push('next-cache');
  }
  return { removed };
}

/** Days a Next build-cache file may go unwritten before it is pruned. */
export const NEXT_CACHE_DAYS = Math.max(1, Number(process.env.NEXT_CACHE_DAYS) || 7);

/**
 * Next's build cache never shrinks by itself: files not written for
 * NEXT_CACHE_DAYS go, after a deploy (no build of this app is running then).
 * Not images/ — the running site serves its optimized images from there.
 * ponytail: by age, so a stale-but-still-referenced pack can go too; the next
 * build then misses that part and rebuilds it, nothing breaks.
 */
export async function pruneNextCache(afs: AppFs): Promise<void> {
  await afs.run(
    ['sh', '-c', `find "$1"/next-cache* -type f -mtime +${NEXT_CACHE_DAYS} ! -path '*/images/*' -delete 2>/dev/null; true`, 'sh', sharedDirFor(afs.appDir)],
    { timeout: 120_000 },
  );
}

/** Measured before and after, so what was freed is a fact, not an estimate. */
export async function cleanupApp(applicationId: string, opts: { cache?: boolean } = {}) {
  const before = await appDiskUsage(applicationId);
  // an imported service's folder is someone else's: measured, never cleaned — a releases/ of its own is not ours to prune
  if (!before || before.imported) return null;
  const { removed } = await cleanupAppReleases(await sourceFsFor(applicationId), applicationId, opts);
  const after = await appDiskUsage(applicationId);
  return { removed, freedBytes: Math.max(0, before.totalBytes - (after?.totalBytes ?? 0)), after };
}

/** Size, used and free bytes of the filesystem tenant homes live on. */
export async function nodeDisk(node: SshTarget): Promise<{ size: number; used: number; avail: number } | null> {
  const home = process.env.CB_HOME_ROOT || '/home';
  const { stdout } = await exec(node, ['df', '-B1', '--output=size,used,avail', home], { timeout: 30_000 }).catch(() => ({ stdout: '' }));
  const [size, used, avail] = (stdout.trim().split('\n')[1] ?? '').trim().split(/\s+/).map(Number);
  return size ? { size, used: used ?? 0, avail: avail ?? 0 } : null;
}

/**
 * Measure what the app takes and store it on its row — its tree on the node,
 * an imported app's folder, or a static site's objects in R2. Returns the bytes,
 * null when there is nothing to measure. After each deploy and on the app-disk cron.
 */
export async function measureAppDisk(applicationId: string): Promise<number | null> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { type: true, runtime: true, rootPath: true, staticBucket: true },
  });
  if (!app) return null;
  let bytes: number | null = null;
  if (app.runtime) {
    // imported: its folder on the server, as the sync found it, and its pm2 logs — a static one too (Caddy's files, not R2)
    bytes = (await appDiskUsage(applicationId))?.totalBytes ?? null;
  } else if (app.type === 'STATIC') {
    if (app.staticBucket) bytes = (await listSiteObjects(app.staticBucket)).reduce((sum, file) => sum + file.size, 0);
  } else {
    bytes = (await appDiskUsage(applicationId))?.totalBytes ?? null;
  }
  if (bytes === null) return null;
  await prisma.application.update({ where: { id: applicationId }, data: { diskBytes: BigInt(bytes), diskMeasuredAt: new Date() } });
  return bytes;
}

/** Every app, one after the other — a du per app is slow, and the cron must not overlap itself. */
export async function measureAllAppDisks(): Promise<string> {
  const apps = await prisma.application.findMany({ select: { id: true }, orderBy: { diskMeasuredAt: { sort: 'asc', nulls: 'first' } } });
  let measured = 0;
  let failed = 0;
  for (const { id } of apps) {
    try {
      if ((await measureAppDisk(id)) !== null) measured += 1;
    } catch (error: any) {
      failed += 1;
      console.warn(`app-disk: ${id}: ${error?.message ?? error}`);
    }
  }
  return `${measured} app(s) measured, ${failed} failed`;
}
