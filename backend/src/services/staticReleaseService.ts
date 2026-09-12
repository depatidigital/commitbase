import { prisma } from '../lib/prisma';
import { deleteSiteObjects, listSiteObjects } from './r2Service';

/**
 * Atomic deploys for static sites. Every deploy writes a fresh folder,
 * `deploys/<deploymentId>/`, inside the site's R2 location; only once every
 * file is in does the Caddy route move to it. The folder that is serving is
 * never written to, so visitors never see half a deploy, and a rollback is
 * pointing the route at an older folder — nothing is uploaded again.
 *
 * - `staticBucket` stays the site's root location (`bucket` or `bucket/prefix`).
 * - `staticOrigin` is the pointer: the public origin of the folder serving now.
 *   Everything that (re)applies the route already reads it.
 * - Each folder is a Release row, `path` = the folder; '' is the site root,
 *   i.e. the files uploaded before releases existed.
 */

export const KEEP_STATIC_RELEASES = 5;

const RELEASE_SUFFIX = /\/(deploys\/[^/]+)$/;

/** The folder a deploy is written to. */
export const releaseFolder = (deploymentId: string) => `deploys/${deploymentId}`;

/** `base` inside `folder` — for a stored location and a public origin alike. */
export const inFolder = (base: string, folder: string) => (folder ? `${base}/${folder}` : base);

/** The site's root origin, whichever release the pointer is on. */
export const siteRootOrigin = (origin: string) => origin.replace(RELEASE_SUFFIX, '');

/** The release folder a site's pointer is on ('' = the root). */
export const servingFolder = (origin: string | null | undefined) => origin?.match(RELEASE_SUFFIX)?.[1] ?? '';

/** Keys of one release. The root holds the releases too, so leave those out. */
export async function listReleaseFiles(bucket: string, folder: string) {
  const files = await listSiteObjects(inFolder(bucket, folder));
  return folder ? files : files.filter((file) => !file.key.startsWith('deploys/'));
}

async function deleteRelease(bucket: string, folder: string): Promise<void> {
  const keys = (await listReleaseFiles(bucket, folder)).map((file) => file.key);
  await deleteSiteObjects(inFolder(bucket, folder), keys);
}

/**
 * A site deployed before releases serves from its root with no Release row.
 * Give those files one before the first release replaces them, so there is
 * something to roll back to.
 */
export async function adoptRootFiles(app: {
  id: string;
  staticBucket: string | null;
  staticOrigin: string | null;
  lastDeployment: Date | null;
}): Promise<void> {
  if (!app.staticBucket || !app.staticOrigin || servingFolder(app.staticOrigin)) return;
  if ((await prisma.release.count({ where: { applicationId: app.id } })) > 0) return;
  if ((await listReleaseFiles(app.staticBucket, '')).length === 0) return;

  const release = await prisma.release.create({
    data: {
      applicationId: app.id,
      status: 'READY',
      path: '',
      ...(app.lastDeployment && { createdAt: app.lastDeployment }),
    },
  });
  await prisma.application.update({ where: { id: app.id }, data: { activeReleaseId: release.id } });
}

/** Remove a deploy that never finished — its files would only take up space. */
export async function discardFolder(bucket: string, folder: string): Promise<void> {
  await deleteRelease(bucket, folder).catch((error: any) =>
    console.error(`Could not clean up ${inFolder(bucket, folder)}:`, error?.message),
  );
}

/** Keep the newest KEEP_STATIC_RELEASES (and always the serving one); drop the rest, files and all. */
export async function pruneStaticReleases(applicationId: string): Promise<void> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { staticBucket: true, activeReleaseId: true },
  });
  if (!app?.staticBucket) return;

  const releases = await prisma.release.findMany({
    where: { applicationId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, path: true },
  });
  for (const release of releases.slice(KEEP_STATIC_RELEASES)) {
    if (release.id === app.activeReleaseId) continue;
    try {
      await deleteRelease(app.staticBucket, release.path ?? '');
      await prisma.release.delete({ where: { id: release.id } });
    } catch (error: any) {
      console.error(`Could not prune release ${release.id}:`, error?.message);
    }
  }
}

/** Everything the site ever uploaded — for deleting the app. */
export async function deleteAllSiteFiles(bucket: string): Promise<void> {
  const keys = (await listSiteObjects(bucket)).map((file) => file.key);
  await deleteSiteObjects(bucket, keys);
}
