import * as path from 'path';
import { Application } from '@prisma/client';
import { currentDirFor, inRootDirectory } from '../lib/appPaths';
import { appFsFor, type AppFs } from '../lib/appFs';
import { execOrg, execRoot, type ExecResult, type SshTarget } from '../lib/runner';
import { envForFile, readEnv, readEnvFiles } from '../lib/appEnv';
import { prisma } from '../lib/prisma';
import { serverForApplication } from '../lib/servers';
import { sourceTreeUnit } from './orgProvisionService';
import type { AppWithOrg } from './systemdService';

/**
 * Compose stacks.
 *
 * A COMPOSE app has no systemd unit: the stack is the process. The node brings
 * it up with `cb-compose` (install.sh), which is Compose v2 pointed at the
 * calling user's own rootless Podman socket — so a tenant's containers run as
 * that tenant, the way its units and its FPM pool already do.
 *
 * Caddy reaches it the same way it reaches every other app: the stack publishes
 * on a loopback port from the platform's pool and the app's `serve` is
 * `{ kind: 'proxy', port }`. What the compose file itself says to publish is
 * overridden — see writeOverride.
 */

export const DEFAULT_COMPOSE_FILE = 'docker-compose.yml';
export const DEFAULT_ENV_FILE = '.env';
/** Written by the deploy, read by compose after the app's own files. */
export const OVERRIDE_FILE = 'docker-compose.override.larika.yml';

export function needsCompose(type: string): boolean {
  return type === 'COMPOSE';
}

/**
 * The compose project name. Derived from the app, never from the directory
 * compose happens to run in — which is what compose would do by itself, and
 * which would be a different project for every release, so every deploy would
 * start the stack again against empty volumes and orphan the old ones.
 */
export function projectName(slug: string, applicationId: string): string {
  return `cb-${slug}-${applicationId}`.toLowerCase();
}

/** The compose files, in -f order. */
export function composeFilesOf(application: Pick<Application, 'composeFiles'>): string[] {
  return application.composeFiles.length > 0 ? application.composeFiles : [DEFAULT_COMPOSE_FILE];
}

/** The env files to write. */
export function composeEnvFilesOf(application: Pick<Application, 'composeEnvFiles'>): string[] {
  return application.composeEnvFiles.length > 0 ? application.composeEnvFiles : [DEFAULT_ENV_FILE];
}

/**
 * The argv for one compose command, without the files the caller has to resolve
 * against the working directory. `--project-directory .` keeps relative build
 * contexts and bind mounts resolving against the app's tree rather than against
 * wherever the override file was written.
 */
export function composeArgv(project: string, files: string[], args: string[]): string[] {
  return ['cb-compose', '--project-name', project, '--project-directory', '.', ...files.flatMap((file) => ['-f', file]), ...args];
}

/** One service's ports as the override writes them. */
export type PortRule = { service: string; ports: string[] };

/**
 * The override compose reads last. Every port the stack publishes is put on
 * loopback: the serving one at the port the platform allocated (Caddy's
 * upstream), every other one at its own host port. Compose files name fixed
 * host ports (5000, 8000, 3306 among the ones we run) on every interface —
 * a datapusher or a database open to the internet, and a collision with the
 * next stack on the node.
 *
 * `!override`, because compose MERGES a later file's ports into the earlier
 * list rather than replacing it: without the tag the stack would keep
 * 0.0.0.0:5000 beside the loopback one. Needs Compose 2.24.4 or newer. Pure.
 */
export function overrideYaml(rules: PortRule[]): string {
  return [
    '# Written by Larika on every deploy — edits here are overwritten.',
    '# The app is reached through Caddy, so the stack is published on loopback only.',
    'services:',
    ...rules.flatMap(({ service, ports }) => [`  ${service}:`, '    ports: !override', ...ports.map((port) => `      - "${port}"`)]),
    '',
  ].join('\n');
}

/**
 * What to publish, from `compose config --format json`: the serving service at
 * the allocated port, every other published port kept but on loopback. Pure.
 */
export function portRules(config: any, main: { service: string; hostPort: number; containerPort: number }): PortRule[] {
  const services: Record<string, any> = config?.services ?? {};
  const rules: PortRule[] = [{ service: main.service, ports: [`127.0.0.1:${main.hostPort}:${main.containerPort}`] }];
  for (const [service, spec] of Object.entries(services)) {
    if (service === main.service || !Array.isArray(spec?.ports) || spec.ports.length === 0) continue;
    const ports = spec.ports
      .filter((p: any) => p?.published && p?.target)
      .map((p: any) => `127.0.0.1:${p.published}:${p.target}${p.protocol && p.protocol !== 'tcp' ? `/${p.protocol}` : ''}`);
    // an empty !override list is still an override: nothing of this service stays published
    rules.push({ service, ports });
  }
  return rules;
}

function slugOf(application: AppWithOrg): string {
  const slug = application.organization?.slug;
  if (!slug) throw new Error(`Application ${application.id} has no organization — assign it one before running its stack`);
  return slug;
}

/** The org's Linux UID on the node, which execOrg needs to find the user session. */
async function uidOf(application: AppWithOrg): Promise<number> {
  const row = await prisma.application.findUnique({
    where: { id: application.id },
    select: { organization: { select: { uid: true } } },
  });
  const uid = row?.organization?.uid;
  if (!uid) {
    throw new Error(
      `The organization of ${application.name} has no UID on its node — re-provision it before running compose apps`
    );
  }
  return uid;
}

/** Where the stack's files are: the live release if there is one, else the checkout. */
export async function stackDirOf(application: AppWithOrg, afs: AppFs): Promise<string> {
  const current = currentDirFor(afs.appDir);
  const tree = (await afs.isDirectory(current)) ? current : afs.sourcesDir;
  return inRootDirectory(tree, application.rootDirectory);
}

type RunOpts = {
  timeout?: number;
  onOutput?: (text: string) => void;
  /** where to run: the live stack when omitted, or a release not live yet */
  cwd?: string;
  /** leave the platform's override out — to read what the app's own files say */
  withoutOverride?: boolean;
  /** no -f at all: the stack by its project name, for `down` when its files are gone */
  withoutFiles?: boolean;
};

/** Run one compose command in the stack's directory, as the org's user. */
/**
 * cb-compose talks to the org user's own podman socket, which provisioning
 * starts once. When it is gone since (the user manager restarted, the socket hit
 * its trigger limit), every compose call fails with "no such file" — so it is
 * started again first, the way provisioning does it. Fixed text: nothing of the
 * user's goes into it. execOrg sets XDG_RUNTIME_DIR and the bus for systemctl --user.
 */
const ENSURE_SOCKET =
  'S="/run/user/$(id -u)/podman/podman.sock"; ' +
  '[ -S "$S" ] || { systemctl --user reset-failed podman.socket podman.service >/dev/null 2>&1; systemctl --user start podman.socket >/dev/null 2>&1; }; ';

async function run(application: AppWithOrg, args: string[], opts: RunOpts = {}): Promise<ExecResult> {
  const slug = slugOf(application);
  const [uid, node, afs] = await Promise.all([uidOf(application), serverForApplication(application.id), appFsFor(application.id)]);
  const cwd = opts.cwd ?? (await stackDirOf(application, afs));
  // The override is only written when there is a port to republish, and compose
  // fails on a -f file that is not there — so it joins the list only if it does.
  const hasOverride = !opts.withoutOverride && !opts.withoutFiles && (await afs.exists(path.posix.join(cwd, OVERRIDE_FILE)));
  const files = opts.withoutFiles ? [] : hasOverride ? [...composeFilesOf(application), OVERRIDE_FILE] : composeFilesOf(application);
  // `cd` in its own argv element, not spliced into a string: the directory comes
  // from the app's root directory, which is user input.
  return execOrg(
    node,
    slug,
    uid,
    ['sh', '-c', ENSURE_SOCKET + 'cd -- "$1" || exit 1; shift; exec "$@"', 'sh', cwd, ...composeArgv(projectName(slug, application.id), files, args)],
    { timeout: opts.timeout ?? 30 * 60_000, ...(opts.onOutput && { onOutput: opts.onOutput }) },
  );
}

/**
 * Write the env files the stack reads, and the port override.
 *
 * The env files merge the same way a PHP app's .env does: what the repository
 * ships is kept, except for the keys the platform sets, which win. The first
 * file gets the app's env, each other file its own (CKAN's .env and
 * .ckan-env are configured apart).
 */
export async function writeComposeEnv(application: AppWithOrg, afs: AppFs, workDir: string): Promise<void> {
  const env = readEnv(application.envVars);
  const extra = readEnvFiles(application.extraEnvVars);

  for (const [index, name] of composeEnvFilesOf(application).entries()) {
    // the first file the app's env, each other its own
    const entries = Object.entries(envForFile(name, index, env, extra)).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
    const file = path.posix.join(workDir, name);
    const shipped = await afs.readText(file).catch(() => '');
    const kept = shipped.split(/\r?\n/).filter((line) => !entries.some(([key]) => line.startsWith(key + '=')));
    const own = entries.map(([key, value]) => `${key}=${quoteEnv(String(value))}`);
    await afs.writeFile(file, [...kept, ...own].join('\n').replace(/\n+$/, '') + '\n', { mode: 0o660 });
    // secrets: never world-readable. The mode above only applies to a new file, and the
    // repository's copy arrives 0664. Fails harmlessly once the tenant owns it (already 660).
    await afs.run(['chmod', '660', file]).catch(() => {});
  }

  // Compose runs as the organization's user, not as the panel's that wrote these: the
  // tree is handed over before `compose config` (in writeOverride) reads the env files
  // as that user, and again after, for the override it just wrote.
  await handToTenant(application);
  await writeOverride(application, afs, workDir);
  await handToTenant(application);
}

/** The app's tree to the organization's user (cb-app-unit chown) — what PHP's publish does too. */
async function handToTenant(application: AppWithOrg): Promise<void> {
  await sourceTreeUnit('chown', slugOf(application), application.sourceId ?? application.id, application.id);
}

/**
 * Double-quoted, with the four characters that mean something inside double
 * quotes escaped. Compose reads these files itself, so this is dotenv's
 * quoting, not a shell's.
 */
export function quoteEnv(value: string): string {
  return `"${value.replace(/([\\"$`])/g, '\\$1').replace(/\n/g, '\\n')}"`;
}

export async function writeOverride(application: AppWithOrg, afs: AppFs, workDir: string): Promise<void> {
  const service = application.composeService;
  const containerPort = application.composePort;
  const hostPort = application.port;
  if (!service || !containerPort || !hostPort) {
    // Nothing to republish — the stack keeps whatever its own files publish.
    // Said in the build log by the caller, not here. One written by an earlier
    // deploy goes: this runs against the live release on a restart too, and a
    // port that was cleared must not stay published.
    await afs.rm(path.posix.join(workDir, OVERRIDE_FILE), { force: true }).catch(() => {});
    return;
  }
  const main = { service, hostPort, containerPort };
  // what the app's own files publish, with its env already in place to interpolate
  const config = await run(application, ['config', '--format', 'json'], { cwd: workDir, withoutOverride: true, timeout: 2 * 60_000 })
    .then((result) => JSON.parse(result.stdout))
    .catch((error: any) => {
      // the serving port alone is still loopback-only; the others stay as the files say
      console.error(`compose config failed for ${application.name}, rebinding only ${service}:`, error?.message);
      return null;
    });
  await afs.writeFile(path.posix.join(workDir, OVERRIDE_FILE), overrideYaml(portRules(config, main)), { mode: 0o660 });
}

/** Bring the stack up, building images that are built from the repository. */
export async function startApplication(application: AppWithOrg, opts: { build?: boolean; onOutput?: (text: string) => void } = {}): Promise<boolean> {
  await run(application, ['up', '-d', ...(opts.build === false ? [] : ['--build'])], opts.onOutput ? { onOutput: opts.onOutput } : {});
  return (await getStatus(application)) === 'RUNNING';
}

/** Stop the containers, keeping them and the volumes. `down` is for deletion. */
export async function stopApplication(application: AppWithOrg): Promise<void> {
  await run(application, ['stop'], { timeout: 5 * 60_000 });
}

export async function restartApplication(application: AppWithOrg): Promise<void> {
  // Env is in files, so rewrite them first or an edit would not take effect.
  const afs = await appFsFor(application.id);
  await writeComposeEnv(application, afs, await stackDirOf(application, afs));
  await run(application, ['up', '-d', '--force-recreate']);
}

/**
 * Take the stack down. Volumes stay unless the caller says otherwise: for these
 * apps the volumes are the database, and an app is deleted far more often than
 * its data is meant to be.
 */
export async function removeApplication(application: AppWithOrg, opts: { volumes?: boolean } = {}): Promise<void> {
  // no org or no UID: compose never ran for it, so there is no stack to take down
  if (!application.organization?.slug || !(await uidOf(application).catch(() => null))) return;
  // images built from the repository go too — nothing else would ever remove them
  const args = ['down', '--remove-orphans', '--rmi', 'local', ...(opts.volumes ? ['-v'] : [])];
  await run(application, args, { timeout: 10 * 60_000 }).catch(() =>
    // the files may be gone (never deployed, a broken release): compose finds the stack by its project name alone
    run(application, args, { timeout: 10 * 60_000, cwd: '/', withoutFiles: true }),
  );
}

/** Follow the stack's logs, the same shape as systemdService.followLogs. */
export function followLogs(
  application: AppWithOrg,
  lines: number,
  onOutput: (text: string) => void,
  signal: AbortSignal
): Promise<unknown> {
  return run(application, ['logs', '--follow', '--tail', String(lines)], { onOutput, timeout: 2 * 60 * 60_000 }).then(
    () => undefined,
    (error: any) => {
      if (signal.aborted) return undefined;
      throw error;
    },
  );
}

/**
 * Run one command in a service of the stack — `ckan user add`, a migration, a
 * seed. argv is a list, never a string: it reaches a real exec, not a shell.
 */
export async function execInService(
  application: AppWithOrg,
  service: string | null,
  argv: string[],
  onOutput?: (text: string) => void
): Promise<ExecResult> {
  const target = service || application.composeService;
  if (!target) throw new Error('Name the service to run this in — the app has no default one');
  if (argv.length === 0) throw new Error('Nothing to run');
  return run(application, ['exec', '-T', target, ...argv], { timeout: 30 * 60_000, ...(onOutput ? { onOutput } : {}) });
}

export type StackService = {
  name: string;
  image: string | null;
  build: boolean;
  ports: string[];
  dependsOn: string[];
  /** what the container gets: its env_file(s) and environment: merged, ${...} filled in */
  environment: Record<string, string>;
  /** the env files it loads, by name */
  envFiles: string[];
};

/** The stack's services as `compose config` reads its files — the app's own, without the platform's override. Pure. */
export function servicesOf(config: any): StackService[] {
  return Object.entries<any>(config?.services ?? {}).map(([name, spec]) => ({
    name,
    image: spec?.build ? null : spec?.image ?? null,
    build: !!spec?.build,
    ports: (Array.isArray(spec?.ports) ? spec.ports : [])
      .filter((p: any) => p?.target)
      .map((p: any) => (p.published ? `${p.published}:${p.target}` : String(p.target))),
    dependsOn: Object.keys(spec?.depends_on ?? {}),
    environment: Object.fromEntries(Object.entries<any>(spec?.environment ?? {}).map(([key, value]) => [key, value == null ? '' : String(value)])),
    // compose prints env_file as paths (absolute, after config) or { path } objects
    envFiles: (Array.isArray(spec?.env_file) ? spec.env_file : spec?.env_file ? [spec.env_file] : []).map((e: any) =>
      path.posix.basename(String(typeof e === 'string' ? e : e?.path ?? '')),
    ),
  }));
}

/** What the stack would run, before anything runs: from the live release, else the pulled checkout. */
export async function previewStack(application: AppWithOrg): Promise<StackService[]> {
  const { stdout } = await run(application, ['config', '--format', 'json'], { withoutOverride: true, timeout: 2 * 60_000 });
  return servicesOf(JSON.parse(stdout));
}

/**
 * Whether every service that is meant to stay up is up. UNKNOWN, never STOPPED,
 * when the node cannot be reached: a status written from a dropped connection
 * sticks until someone notices. Same contract as systemdService.getStatus.
 */
export async function getStatus(application: AppWithOrg): Promise<'RUNNING' | 'STOPPED' | 'UNKNOWN'> {
  try {
    const { stdout } = await run(application, ['ps', '--format', 'json'], { timeout: 60_000 });
    return readPsStatus(stdout);
  } catch {
    return 'UNKNOWN';
  }
}

/**
 * Compose v2 prints either a JSON array or one object per line, depending on
 * its version. A stack is RUNNING when it has containers and none of the ones
 * that should be up are down; a service that exited cleanly (a migration, a
 * one-shot) does not make the stack stopped.
 */
export function readPsStatus(stdout: string): 'RUNNING' | 'STOPPED' {
  const text = stdout.trim();
  if (!text) return 'STOPPED';

  let rows: any[];
  try {
    rows = text.startsWith('[')
      ? JSON.parse(text)
      : text
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
  } catch {
    return 'STOPPED';
  }
  if (rows.length === 0) return 'STOPPED';

  return rows.some((row) => ['running', 'restarting'].includes(String(row?.State ?? row?.state ?? '').toLowerCase()))
    ? 'RUNNING'
    : 'STOPPED';
}

export type { SshTarget };

/** What a stack takes on its node, outside the app's folder: in the org user's Podman. */
export type StackUsage = {
  /** the images its containers run — built from the repository, or pulled (redis, solr…) */
  imagesBytes: number;
  /** each container's own writable layer: what it wrote outside its volumes */
  containersBytes: number;
  /** its named volumes: the stack's data (its database, its uploads) */
  volumesBytes: number;
};

/**
 * The stack's share of its org's Podman, found by its compose project label
 * (projectName) — never another app's. Null when the stack never ran (no org,
 * no UID). ponytail: an image two stacks of one org both use is counted in each
 * — an upper bound, like the node cleanup's; per-layer accounting if it matters.
 */
export async function stackUsage(application: AppWithOrg): Promise<StackUsage | null> {
  const slug = application.organization?.slug;
  const uid = slug ? await uidOf(application).catch(() => null) : null;
  if (!slug || !uid) return null;
  const node = await serverForApplication(application.id);
  const label = `label=com.docker.compose.project=${projectName(slug, application.id)}`;
  const podman = async (args: string[]): Promise<any[]> =>
    JSON.parse((await execOrg(node, slug, uid, ['podman', ...args], { timeout: 120_000 })).stdout || '[]') ?? [];

  const [containers, volumes] = await Promise.all([
    podman(['ps', '-a', '--size', '--filter', label, '--format', 'json']),
    podman(['volume', 'ls', '--filter', label, '--format', 'json']),
  ]);
  const imageIds = [...new Set(containers.map((c) => String(c.ImageID ?? '')).filter(Boolean))];
  const images = imageIds.length ? await podman(['image', 'inspect', '--format', 'json', ...imageIds]).catch(() => []) : [];
  const mounts = volumes.map((v) => v.Mountpoint).filter((m): m is string => typeof m === 'string' && m.startsWith('/'));
  // as root: a volume's files belong to the container's mapped uids, not the org user
  const du = mounts.length ? await execRoot(node, ['du', '-scb', '--', ...mounts], { timeout: 300_000 }).catch(() => null) : null;

  return {
    imagesBytes: images.reduce((sum, image) => sum + (Number(image.Size) || 0), 0),
    containersBytes: containers.reduce((sum, c) => sum + (Number(c.Size?.rwSize ?? c.Size?.RwSize) || 0), 0),
    // the last line of du -c is the total
    volumesBytes: Number(du?.stdout.trim().split('\n').pop()?.split('\t')[0]) || 0,
  };
}
