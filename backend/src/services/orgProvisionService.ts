import * as fs from 'fs';
import * as path from 'path';
import { prisma } from '../lib/prisma';
import { exec, remoteExists, remoteReadDir, rootArgv, type SshTarget, type ExecOptions } from '../lib/runner';
import { serverForOrg } from '../lib/servers';
import { ORG_SLUG_RE, APP_ID_RE, orgHome, orgAppsDir, osUserFor, orgSlicePath } from '../lib/appPaths';

/**
 * Per-organization OS isolation.
 *
 * Provisioning nodes are separate machines, so every call goes over SSH to the
 * node the organization is placed on. The control plane's own VM is a Server
 * row like any other — there is no local shortcut, so there is one code path.
 *
 * Nothing is installed on the node: the runner scripts live in this repo and
 * their text is sent with every call as `bash -c <script> <name> <args...>`.
 * A node therefore always runs the script that matches this panel's version.
 * The price is that the SSH user needs passwordless root (root itself, or
 * NOPASSWD: ALL) — see rootArgv in runner.ts.
 *
 * Arguments are still passed as an array, never as a shell string; runner.ts
 * quotes each element (the script text included), so nothing from the database
 * can be read as a shell metacharacter on the way to a root command. The
 * scripts revalidate their own arguments as well.
 */

export const OS_ISOLATION_ENABLED = process.env.ORG_OS_ISOLATION === 'true';

// Same depth from src/services (tsx) and dist/services (node): backend/<x>/services → repo root.
const RUNNER_DIR = path.resolve(__dirname, '../../../runner');
const scripts = new Map<string, string>();

function script(name: 'cb-provision-org' | 'cb-app-unit'): string {
  let text = scripts.get(name);
  if (!text) {
    text = fs.readFileSync(path.join(RUNNER_DIR, `${name}.sh`), 'utf8');
    scripts.set(name, text);
  }
  return text;
}

const DEFAULT_DISK_QUOTA = process.env.ORG_DISK_QUOTA || '20G';
const DEFAULT_CPU_QUOTA = process.env.ORG_CPU_QUOTA || '50%';
const DEFAULT_MEMORY_MAX = process.env.ORG_MEMORY_MAX || '1G';

const QUOTA_RE = /^[0-9]+[MG]$/;
const CPU_RE = /^[0-9]+%$/;

function assertSlug(slug: string) {
  if (!ORG_SLUG_RE.test(slug)) throw new Error(`Invalid organization slug: ${slug}`);
}

/** Run one runner script as root on the node, its text sent inline. $0 is the script name. */
function runScript(server: SshTarget, name: 'cb-provision-org' | 'cb-app-unit', args: string[], opts: ExecOptions = {}) {
  return exec(server, rootArgv(server, ['bash', '-c', script(name), name, ...args]), opts);
}

async function sudo(server: SshTarget, name: 'cb-provision-org' | 'cb-app-unit', args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await runScript(server, name, args, { timeout });
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
 * pool for one organization, on that organization's node. Idempotent — safe to
 * call on every org write, and safe to retry after a dropped connection.
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

  const server = await serverForOrg(slug);
  const output = await sudo(server, 'cb-provision-org', [slug, diskQuota, cpuQuota, memoryMax]);
  return { provisioned: true, osUser: osUserFor(slug), home: orgHome(slug), output };
}

export type AppUnitAction = 'install' | 'start' | 'stop' | 'restart' | 'remove' | 'status' | 'chown';

const BUILD_MEMORY_MAX = process.env.BUILD_MEMORY_MAX || '2G';
const BUILD_CPU_WEIGHT = process.env.BUILD_CPU_WEIGHT || '50';

export async function appUnit(action: AppUnitAction, slug: string, applicationId: string): Promise<string> {
  if (!OS_ISOLATION_ENABLED) throw new Error('ORG_OS_ISOLATION is not enabled');
  assertSlug(slug);
  if (!APP_ID_RE.test(applicationId)) throw new Error(`Invalid application id: ${applicationId}`);
  return sudo(await serverForOrg(slug), 'cb-app-unit', [action, slug, applicationId]);
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

  const server = await serverForOrg(slug);
  const { stdout, stderr } = await runScript(
    server,
    'cb-app-unit',
    ['build', slug, applicationId, BUILD_MEMORY_MAX, BUILD_CPU_WEIGHT],
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
  /** Name of the node this org is placed on, or null when it has none yet. */
  server: string | null;
  /** true once the OS user's home exists on the node */
  provisioned: boolean;
  /** true once the cgroup slice unit has been written */
  sliceInstalled: boolean;
  appCount: number;
  /** Set when the node could not be reached at all — distinct from "not provisioned". */
  unreachable?: string;
}

/**
 * Read-only check — no sudo, no side effects. Safe to call on every page load.
 *
 * These were local fs.access/readdir calls when there was one box. They are the
 * same three questions asked over the same SSH channel, rather than a second
 * transport (SFTP) to keep working.
 */
export async function getProvisionStatus(slug: string): Promise<ProvisionStatus> {
  assertSlug(slug);
  const home = orgHome(slug);
  const base = {
    enabled: OS_ISOLATION_ENABLED,
    slug,
    osUser: osUserFor(slug),
    home,
    provisioned: false,
    sliceInstalled: false,
    appCount: 0,
  };

  const org = await prisma.organization.findUnique({
    where: { slug },
    select: {
      server: {
        select: {
          id: true,
          name: true,
          hostname: true,
          sshUser: true,
          sshPort: true,
          sshKeyPath: true,
          authMethod: true,
          sshPassword: true,
        },
      },
    },
  });
  const server = org?.server ?? null;
  if (!server) return { ...base, server: null };

  try {
    const [provisioned, sliceInstalled, apps] = await Promise.all([
      remoteExists(server, home),
      remoteExists(server, orgSlicePath(slug)),
      remoteReadDir(server, orgAppsDir(slug)),
    ]);
    return { ...base, server: server.name, provisioned, sliceInstalled, appCount: apps.length };
  } catch (err: any) {
    // An unreachable node must not read as an unprovisioned org — that would
    // invite an admin to "repair" a tenant that is perfectly fine.
    return { ...base, server: server.name, unreachable: err?.message || String(err) };
  }
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
