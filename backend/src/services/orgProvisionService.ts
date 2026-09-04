import { execFile } from 'child_process';
import { promisify } from 'util';
import { ORG_SLUG_RE, APP_ID_RE, orgHome } from '../lib/appPaths';

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

export type AppUnitAction = 'install' | 'start' | 'stop' | 'restart' | 'remove' | 'status';

export async function appUnit(action: AppUnitAction, slug: string, applicationId: string): Promise<string> {
  if (!OS_ISOLATION_ENABLED) throw new Error('ORG_OS_ISOLATION is not enabled');
  assertSlug(slug);
  if (!APP_ID_RE.test(applicationId)) throw new Error(`Invalid application id: ${applicationId}`);
  return sudo(APP_UNIT_SCRIPT, [action, slug, applicationId]);
}
