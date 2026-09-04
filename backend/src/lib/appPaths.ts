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
 * Applications with no organization (or installs that have not migrated yet)
 * fall back to the old flat APPS_DIR. Both shapes key the directory on the
 * application id — some log helpers used to key it on the domain instead and
 * therefore read a directory that never existed.
 */

const HOME_ROOT = process.env.CB_HOME_ROOT || '/home';
const LEGACY_APPS_DIR = process.env.APPS_DIR || path.join(process.cwd(), 'apps_dir');

/** Must match the validation in runner/cb-provision-org.sh. */
export const ORG_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const APP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const osUserFor = (slug: string) => `cb-${slug}`;
export const orgHome = (slug: string) => path.join(HOME_ROOT, osUserFor(slug));
export const orgAppsDir = (slug: string) => path.join(orgHome(slug), 'apps');

/** Synchronous form, for callers that already loaded the organization. */
export function appDirFor(applicationId: string, orgSlug?: string | null): string {
  if (!APP_ID_RE.test(applicationId)) {
    throw new Error(`Invalid application id: ${applicationId}`);
  }
  // Only an absent organization falls back — an empty-string slug is a bug,
  // not a tenant-less app, and must not silently share the legacy directory.
  if (orgSlug === null || orgSlug === undefined) return path.join(LEGACY_APPS_DIR, applicationId);
  if (!ORG_SLUG_RE.test(orgSlug)) {
    throw new Error(`Invalid organization slug: ${orgSlug}`);
  }
  return path.join(orgAppsDir(orgSlug), applicationId);
}

export const sourcesDirFor = (appDir: string) => path.join(appDir, 'sources');
export const logsDirFor = (appDir: string) => path.join(appDir, 'logs');

export async function orgSlugForApp(applicationId: string): Promise<string | null> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { organization: { select: { slug: true } } },
  });
  return app?.organization?.slug ?? null;
}

/** Resolve by application id. One query — deploy paths, not hot loops. */
export async function resolveAppDir(applicationId: string): Promise<string> {
  return appDirFor(applicationId, await orgSlugForApp(applicationId));
}

/** Resolve by hostname, for the log endpoints that only carry a domain. */
export async function resolveAppDirByDomain(domain: string): Promise<string | null> {
  const app = await prisma.application.findFirst({
    where: { domain },
    select: { id: true, organization: { select: { slug: true } } },
  });
  if (!app) return null;
  return appDirFor(app.id, app.organization?.slug ?? null);
}
