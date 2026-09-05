import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { prisma } from '../lib/prisma';
import { ORG_SLUG_RE, APP_ID_RE, orgHome, orgAppsDir, osUserFor } from '../lib/appPaths';

const execFileAsync = promisify(execFile);

/**
 * Per-organization OS isolation.
 *
 * Every call goes through execFile with an argument array — never a shell
 * string — so nothing from the database can be interpreted as a shell
 * metacharacter on the way to a root command. The scripts revalidate their own
 * arguments because the sudoers entry cannot.
 */

export const OS_ISOLATION_ENABLED = process.env.ORG_OS_ISOLATION === 'true';

const PROVISION_SCRIPT = process.env.ORG_PROVISION_SCRIPT || '/usr/local/bin/cb-provision-org';
const APP_UNIT_SCRIPT = process.env.APP_UNIT_SCRIPT || '/usr/local/bin/cb-app-unit';

const DEFAULT_DISK_QUOTA = process.env.ORG_DISK_QUOTA || '20G';
const DEFAULT_CPU_QUOTA = process.env.ORG_CPU_QUOTA || '50%';
const DEFAULT_MEMORY_MAX = process.env.ORG_MEMORY_MAX || '1G';

const QUOTA_RE = /^[0-9]+[MG]$/;
const CPU_RE = /^[0-9]+%$/;

function assertSlug(slug: string) {
  if (!ORG_SLUG_RE.test(slug)) throw new Error(`Invalid organization slug: ${slug}`);
}

async function sudo(script: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('sudo', ['-n', script, ...args], { timeout: 60_000 });
  return stdout.trim();
}

export interface ProvisionResult {
  provisioned: boolean;
  osUser?: string;
  home?: string;
  output?: string;
  reason?: string;
}

/**
 * Create (or repair) the OS user, home, disk quota, cgroup slice and PHP-FPM
 * pool for one organization. Idempotent — safe to call on every org write.
 */
export async function provisionOrg(
  slug: string,
  opts: { diskQuota?: string; cpuQuota?: string; memoryMax?: string } = {}
): Promise<ProvisionResult> {
  if (!OS_ISOLATION_ENABLED) return { provisioned: false, reason: 'ORG_OS_ISOLATION is not enabled' };
  assertSlug(slug);

  const diskQuota = opts.diskQuota || DEFAULT_DISK_QUOTA;
  const cpuQuota = opts.cpuQuota || DEFAULT_CPU_QUOTA;
  const memoryMax = opts.memoryMax || DEFAULT_MEMORY_MAX;

  if (!QUOTA_RE.test(diskQuota)) throw new Error(`Invalid disk quota: ${diskQuota}`);
  if (!CPU_RE.test(cpuQuota)) throw new Error(`Invalid CPU quota: ${cpuQuota}`);
  if (!QUOTA_RE.test(memoryMax)) throw new Error(`Invalid memory max: ${memoryMax}`);

  const output = await sudo(PROVISION_SCRIPT, [slug, diskQuota, cpuQuota, memoryMax]);
  return { provisioned: true, osUser: `cb-${slug}`, home: orgHome(slug), output };
}

export type AppUnitAction = 'install' | 'start' | 'stop' | 'restart' | 'remove' | 'status' | 'chown';

const BUILD_MEMORY_MAX = process.env.BUILD_MEMORY_MAX || '2G';
const BUILD_CPU_WEIGHT = process.env.BUILD_CPU_WEIGHT || '50';

export async function appUnit(action: AppUnitAction, slug: string, applicationId: string): Promise<string> {
  if (!OS_ISOLATION_ENABLED) throw new Error('ORG_OS_ISOLATION is not enabled');
  assertSlug(slug);
  if (!APP_ID_RE.test(applicationId)) throw new Error(`Invalid application id: ${applicationId}`);
  return sudo(APP_UNIT_SCRIPT, [action, slug, applicationId]);
}

/**
 * Run <app-dir>/build.sh inside the build cgroup (memory-capped, low CPU/IO
 * weight). Resolves with the combined output; rejects with it attached when
 * the script fails. Fifteen minutes, same as the in-process build used to get.
 */
export async function appBuild(slug: string, applicationId: string): Promise<string> {
  if (!OS_ISOLATION_ENABLED) throw new Error('ORG_OS_ISOLATION is not enabled');
  assertSlug(slug);
  if (!APP_ID_RE.test(applicationId)) throw new Error(`Invalid application id: ${applicationId}`);
  const { stdout, stderr } = await execFileAsync(
    'sudo',
    ['-n', APP_UNIT_SCRIPT, 'build', slug, applicationId, BUILD_MEMORY_MAX, BUILD_CPU_WEIGHT],
    { timeout: 900_000, maxBuffer: 64 * 1024 * 1024 }
  );
  return stdout + (stderr ? '\n' + stderr : '');
}


/**
 * Provisioning is recorded in the existing Log model so an admin can see what
 * happened without shell access. metadata.scope = 'provisioning' is what the
 * admin log endpoint filters on.
 */
async function logProvision(
  level: 'INFO' | 'WARN' | 'ERROR',
  message: string,
  userId: string,
  metadata: Record<string, unknown>
) {
  try {
    await prisma.log.create({
      data: { level, message, userId, metadata: { scope: 'provisioning', ...metadata } as any },
    });
  } catch (err) {
    // A logging failure must never take down a provisioning run.
    console.error('Failed to write provisioning log:', err);
  }
}

export interface ProvisionStatus {
  enabled: boolean;
  slug: string;
  osUser: string;
  home: string;
  /** true once the OS user's home exists and is reachable by the backend */
  provisioned: boolean;
  /** true once the cgroup slice unit has been written */
  sliceInstalled: boolean;
  appCount: number;
}

/** Read-only check — no sudo, no side effects. Safe to call on every page load. */
export async function getProvisionStatus(slug: string): Promise<ProvisionStatus> {
  assertSlug(slug);
  const home = orgHome(slug);
  const exists = (p: string) => fs.access(p).then(() => true).catch(() => false);

  const [provisioned, sliceInstalled, apps] = await Promise.all([
    exists(home),
    exists(path.join('/etc/systemd/system', `cb-${slug}.slice`)),
    fs.readdir(orgAppsDir(slug)).catch(() => [] as string[]),
  ]);

  return {
    enabled: OS_ISOLATION_ENABLED,
    slug,
    osUser: osUserFor(slug),
    home,
    provisioned,
    sliceInstalled,
    appCount: apps.length,
  };
}

/**
 * provisionOrg plus an audit trail. Use this from anything an admin triggers;
 * the bare provisionOrg stays for scripts that have no user to attribute to.
 */
export async function provisionOrgLogged(
  slug: string,
  userId: string,
  opts: { diskQuota?: string; cpuQuota?: string; memoryMax?: string; organizationId?: string; trigger?: string } = {}
): Promise<ProvisionResult> {
  const base = { organizationId: opts.organizationId ?? null, slug, trigger: opts.trigger ?? 'manual' };

  if (!OS_ISOLATION_ENABLED) {
    await logProvision('WARN', `Provisioning skipped for "${slug}" — ORG_OS_ISOLATION is off`, userId, base);
    return { provisioned: false, reason: 'ORG_OS_ISOLATION is not enabled' };
  }

  try {
    const result = await provisionOrg(slug, opts);
    await logProvision('INFO', `Provisioned OS user cb-${slug}`, userId, { ...base, output: result.output });
    return result;
  } catch (err: any) {
    const message = err?.stderr || err?.message || String(err);
    await logProvision('ERROR', `Provisioning failed for "${slug}": ${message}`, userId, base);
    throw err;
  }
}
