import { prisma } from '../lib/prisma';
import { appFsFor, type AppFs } from '../lib/appFs';
import { currentDirFor, logsDirFor, releasesDirFor, sharedDirFor, sourcesDirFor } from '../lib/appPaths';
import { exec, type SshTarget } from '../lib/runner';
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
  /** Next.js build cache, shared by every release — rebuilt on the next build if removed */
  cacheBytes: number;
  logsBytes: number;
  sourcesBytes: number;
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

/** The app's disk use on its node. Null for a static site — its files are in R2. */
export async function appDiskUsage(applicationId: string, keep = KEEP_RELEASES): Promise<AppDisk | null> {
  const app = await prisma.application.findUnique({ where: { id: applicationId }, select: { type: true, runtime: true } });
  if (!app || app.type === 'STATIC' || app.runtime) return null;
  const afs = await appFsFor(applicationId);

  const { releases } = await releasesOf(afs, applicationId, keep);
  const cache = join(sharedDirFor(afs.appDir), 'next-cache');
  const logs = logsDirFor(afs.appDir);
  const sources = sourcesDirFor(afs.appDir);
  const measured = await sizes(afs, [...releases.map((r) => r.path), cache, sources, logs]);

  const rows = releases.map((r) => ({ name: r.name, bytes: measured.get(r.path) ?? 0, state: r.state }));
  const cacheBytes = measured.get(cache) ?? 0;
  const logsBytes = measured.get(logs) ?? 0;
  const sourcesBytes = measured.get(sources) ?? 0;
  return {
    releases: rows,
    cacheBytes,
    logsBytes,
    sourcesBytes,
    totalBytes: rows.reduce((sum, r) => sum + r.bytes, 0) + cacheBytes + logsBytes + sourcesBytes,
    reclaimableBytes: rows.filter((r) => r.state === 'unused').reduce((sum, r) => sum + r.bytes, 0),
  };
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
  const removed: string[] = [];
  for (const release of releases) {
    if (release.state !== 'unused') continue;
    await afs.rm(release.path, { recursive: true, force: true }).catch(() => {});
    removed.push(release.name);
  }
  const gone = new Set(releases.filter((r) => r.state === 'unused').map((r) => r.path));
  const staleRows = ready.filter((r) => gone.has(r.path!)).map((r) => r.id);
  // never the active one: it is `live`, so its tree is not in `gone`
  if (staleRows.length) await prisma.release.deleteMany({ where: { id: { in: staleRows } } });

  if (cache) {
    await afs.rm(join(sharedDirFor(afs.appDir), 'next-cache'), { recursive: true, force: true }).catch(() => {});
    removed.push('next-cache');
  }
  return { removed };
}

/** Measured before and after, so what was freed is a fact, not an estimate. */
export async function cleanupApp(applicationId: string, opts: { cache?: boolean } = {}) {
  const before = await appDiskUsage(applicationId);
  if (!before) return null;
  const { removed } = await cleanupAppReleases(await appFsFor(applicationId), applicationId, opts);
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
