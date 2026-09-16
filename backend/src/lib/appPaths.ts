import * as path from 'path';
import { prisma } from './prisma';

/**
 * Where an application's files live on disk.
 *
 * With per-organization OS isolation on, every org gets a Linux user
 * `cb-<slug>` and its own home, so one tenant's files are unreachable to
 * another tenant's processes:
 *
 *   /home/cb-<slug>/apps/<applicationId>/sources
 *   /home/cb-<slug>/apps/<applicationId>/logs
 *
 * Keyed on the application id — some log helpers used to key it on the domain
 * instead and therefore read a directory that never existed.
 */

export const HOME_ROOT = process.env.CB_HOME_ROOT || '/home';

/** Must match the validation in runner/cb-provision-org.sh. */
export const ORG_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const APP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Tenant paths are always on a Linux node, never on the machine the control
 * plane happens to run on, so they are joined with path.posix. A Windows dev
 * box would otherwise emit backslashes and every remote `test -e` would miss.
 */
export const osUserFor = (slug: string) => `cb-${slug}`;
export const orgHome = (slug: string) => path.posix.join(HOME_ROOT, osUserFor(slug));
export const orgAppsDir = (slug: string) => path.posix.join(orgHome(slug), 'apps');
export const orgSlicePath = (slug: string) => path.posix.join('/etc/systemd/system', `cb-${slug}.slice`);

/** Synchronous form, for callers that already loaded the organization. */
export function appDirFor(applicationId: string, orgSlug: string): string {
  if (!APP_ID_RE.test(applicationId)) {
    throw new Error(`Invalid application id: ${applicationId}`);
  }
  if (!ORG_SLUG_RE.test(orgSlug)) {
    throw new Error(`Invalid organization slug: ${orgSlug}`);
  }
  return path.posix.join(orgAppsDir(orgSlug), applicationId);
}

/**
 * The checkout an app builds from. One per project, in the tree of the app whose
 * id the project shares (its first): `apps/<sourceId>/sources`, a sibling of the
 * other apps' — pulled once for all of them, while each app builds and runs from
 * its own releases/ and current. Without a source, the app's own.
 */
export const sourcesDirFor = (appDir: string, sourceId?: string | null) =>
  path.posix.join(sourceId ? path.posix.join(path.posix.dirname(appDir), sourceId) : appDir, 'sources');
export const logsDirFor = (appDir: string) => path.posix.join(appDir, 'logs');
/**
 * Runtime apps build into an immutable copy per deploy and run from the
 * `current` symlink, so a build never touches the tree that is serving:
 *
 *   apps/<id>/sources              git checkout or upload — the input
 *   apps/<id>/releases/<stamp>     copy of sources, installed and built
 *   apps/<id>/current -> releases/<stamp>
 *   apps/<id>/shared/next-cache    .next/cache, linked into every release
 */
export const releasesDirFor = (appDir: string) => path.posix.join(appDir, 'releases');
export const currentDirFor = (appDir: string) => path.posix.join(appDir, 'current');
export const sharedDirFor = (appDir: string) => path.posix.join(appDir, 'shared');

/**
 * The tree an app's code is in: its own directory — sources/, releases/,
 * current, build.sh, run.sh and the unit's logs, all of them. The apps of a
 * monorepo each clone the repository into their own tree and deploy on their
 * own; a project deploy is each of its apps deployed. Kept as a function: the
 * callers say "the source's tree" and that is where it is.
 */
export const sourceDirOf = (appDir: string, _sourceId?: string | null) => appDir;

/**
 * An app's folder inside the repository (monorepos): plain relative segments,
 * no `.` or `..` — it ends up in a `cd`. Checked on the cleaned value.
 */
export const ROOT_DIRECTORY_RE = /^(?!(?:.*\/)?\.\.?(?:\/|$))[\w.-]+(?:\/[\w.-]+)*$/;
/** '' / '/' / '  apps/web/ ' → null / null / 'apps/web' */
export const cleanRootDirectory = (raw: unknown): string | null =>
  String(raw ?? '').trim().replace(/^\/+|\/+$/g, '') || null;
/** `base` (a release, sources/) inside the app's folder */
export const inRootDirectory = (base: string, rootDirectory: string | null | undefined) =>
  rootDirectory ? path.posix.join(base, rootDirectory) : base;

export async function orgSlugForApp(applicationId: string): Promise<string | null> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { organization: { select: { slug: true } } },
  });
  return app?.organization?.slug ?? null;
}
