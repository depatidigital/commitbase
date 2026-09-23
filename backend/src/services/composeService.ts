import * as path from 'path';
import { Application } from '@prisma/client';
import { currentDirFor, inRootDirectory } from '../lib/appPaths';
import { appFsFor, type AppFs } from '../lib/appFs';
import { execOrg, type ExecResult, type SshTarget } from '../lib/runner';
import { readEnv } from '../lib/appEnv';
import { prisma } from '../lib/prisma';
import { serverForApplication } from '../lib/servers';
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

/**
 * The override compose reads last: it republishes every port on loopback, at
 * the port the platform allocated. Compose files name their own host ports
 * (5000, 8080, 3306 among the ones we run), which collide between apps on one
 * node and, worse, publish databases on every interface.
 */
export function overrideYaml(service: string, hostPort: number, containerPort: number): string {
  return [
    '# Written by Larika on every deploy — edits here are overwritten.',
    '# The app is reached through Caddy, so the stack is published on loopback only.',
    'services:',
    `  ${service}:`,
    '    ports:',
    `      - "127.0.0.1:${hostPort}:${containerPort}"`,
    '',
  ].join('\n');
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

/** Run one compose command in the stack's directory, as the org's user. */
async function run(application: AppWithOrg, args: string[], opts: { timeout?: number; onOutput?: (text: string) => void } = {}): Promise<ExecResult> {
  const slug = slugOf(application);
  const [uid, node, afs] = await Promise.all([uidOf(application), serverForApplication(application.id), appFsFor(application.id)]);
  const cwd = await stackDirOf(application, afs);
  // The override is only written when there is a port to republish, and compose
  // fails on a -f file that is not there — so it joins the list only if it does.
  const hasOverride = await afs.exists(path.posix.join(cwd, OVERRIDE_FILE));
  const files = hasOverride ? [...composeFilesOf(application), OVERRIDE_FILE] : composeFilesOf(application);
  // `cd` in its own argv element, not spliced into a string: the directory comes
  // from the app's root directory, which is user input.
  return execOrg(
    node,
    slug,
    uid,
    ['sh', '-c', 'cd -- "$1" || exit 1; shift; exec "$@"', 'sh', cwd, ...composeArgv(projectName(slug, application.id), files, args)],
    { timeout: 30 * 60_000, ...opts },
  );
}

/**
 * Write the env files the stack reads, and the port override.
 *
 * The env files merge the same way a PHP app's .env does: what the repository
 * ships is kept, except for the keys the platform sets, which win. Every file
 * in composeEnvFiles gets the same content — a stack that splits its
 * configuration across two files (CKAN's .env and .ckan-env) reads the same
 * variables from either.
 */
export async function writeComposeEnv(application: AppWithOrg, afs: AppFs, workDir: string): Promise<void> {
  const env = readEnv(application.envVars);
  const entries = Object.entries(env).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));

  for (const name of composeEnvFilesOf(application)) {
    const file = path.posix.join(workDir, name);
    const shipped = await afs.readText(file).catch(() => '');
    const kept = shipped.split(/\r?\n/).filter((line) => !entries.some(([key]) => line.startsWith(key + '=')));
    const own = entries.map(([key, value]) => `${key}=${quoteEnv(String(value))}`);
    await afs.writeFile(file, [...kept, ...own].join('\n').replace(/\n+$/, '') + '\n', { mode: 0o660 });
  }

  await writeOverride(application, afs, workDir);
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
  await afs.writeFile(path.posix.join(workDir, OVERRIDE_FILE), overrideYaml(service, hostPort, containerPort), { mode: 0o660 });
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
  await run(application, ['down', '--remove-orphans', ...(opts.volumes ? ['-v'] : [])], { timeout: 10 * 60_000 });
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
