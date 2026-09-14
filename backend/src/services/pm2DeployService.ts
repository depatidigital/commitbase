import type { AppStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { exec, type SshTarget } from '../lib/runner';
import { listPm2Processes } from './appSyncService';

/**
 * Build and restart an imported pm2 app where it lives: its own folder on its
 * own node, as the folder's owner — install (by its lockfile), build (its
 * package.json `build` script), `pm2 restart <name>`. There is no release
 * folder to build beside, so the site can err while the build rewrites its
 * output; the caller asked the user first. Runs in the background and writes
 * its log onto a deployment row as it goes.
 */

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

/** The package manager a folder's lockfile says. Pure. */
export function packageManager(files: string[]): PackageManager {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('yarn.lock')) return 'yarn';
  if (files.includes('bun.lockb') || files.includes('bun.lock')) return 'bun';
  return 'npm';
}

/**
 * The steps, as argv — never a shell string, so nothing stored or typed
 * anywhere becomes a command. Install is skipped without a package.json;
 * build without a `build` script. Pure.
 */
export function pm2DeploySteps(files: string[], packageJson: string | null, processName: string): Array<{ label: string; argv: string[] }> {
  const steps: Array<{ label: string; argv: string[] }> = [];
  if (packageJson !== null) {
    const manager = packageManager(files);
    // exactly the lockfile's versions, like a deploy — never a silent upgrade
    const install: Record<PackageManager, string[]> = {
      pnpm: ['pnpm', 'install', '--frozen-lockfile'],
      yarn: ['yarn', 'install', '--frozen-lockfile'],
      bun: ['bun', 'install', '--frozen-lockfile'],
      npm: files.includes('package-lock.json') ? ['npm', 'ci'] : ['npm', 'install'],
    };
    steps.push({ label: 'install', argv: install[manager] });
    let scripts: Record<string, unknown> = {};
    try {
      scripts = JSON.parse(packageJson)?.scripts ?? {};
    } catch {
      // not JSON: nothing to build by
    }
    if (typeof scripts.build === 'string' && scripts.build.trim()) {
      steps.push({ label: 'build', argv: manager === 'yarn' ? ['yarn', 'build'] : [manager, 'run', 'build'] });
    }
  }
  steps.push({ label: 'restart', argv: ['pm2', 'restart', processName] });
  return steps;
}

/**
 * Runs `argv` in `dir` with nvm's node on the PATH — how these boxes install
 * node — and CI=true: there is no terminal to answer a prompt (pnpm refuses to
 * rebuild node_modules without one otherwise). The node is the one pm2 runs
 * the app with: the newest installed is not it (a Prisma that supports 24
 * refuses 25). Unknown or not installed under nvm: every nvm node, as before.
 */
const inDir = (dir: string, nodeVersion: string | undefined, argv: string[]) => [
  'sh',
  '-c',
  'v="$HOME/.nvm/versions/node/v$1/bin"; if [ -n "$1" ] && [ -d "$v" ]; then PATH="$v:$PATH"; else for d in "$HOME"/.nvm/versions/node/*/bin; do PATH="$d:$PATH"; done; fi; export CI=true; cd -- "$0" && shift && exec "$@"',
  dir,
  nodeVersion && /^[0-9][0-9.]*$/.test(nodeVersion) ? nodeVersion : '',
  ...argv,
];

/** Why the panel must not write in `dir`, or null when it may: only as the folder's owner. */
export async function notOwner(server: SshTarget, dir: string): Promise<string | null> {
  const { stdout: who } = await exec(server, ['sh', '-c', 'stat -c %U -- "$1" && id -un', 'sh', dir], { timeout: 15_000 });
  const [owner, user] = who.trim().split('\n');
  return !owner || owner !== user
    ? `${dir} belongs to ${owner ?? 'another user'}, but the panel logs in as ${user}. Run it on the server as ${owner}.`
    : null;
}

// one at a time per folder: two builds writing one output is two broken builds
const running = new Set<string>();

export class Pm2DeployError extends Error {}

/**
 * Start one. Checks everything that can be checked up front (throws
 * Pm2DeployError), then returns the deployment row's id while the steps run.
 */
export async function startPm2Deploy(applicationId: string, userId: string): Promise<string> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { id: true, name: true, runtime: true, processName: true, rootPath: true, serverId: true, sourceId: true, status: true },
  });
  if (!app || app.runtime !== 'PM2' || !app.processName || !app.rootPath) {
    throw new Pm2DeployError('Only an app pm2 runs from a known folder can be built here');
  }
  const server = app.serverId ? await prisma.server.findUnique({ where: { id: app.serverId } }) : null;
  if (!server) throw new Pm2DeployError('This pm2 app is not linked to a server — sync the apps again');
  const dir = app.rootPath;
  if (running.has(`${server.id}:${dir}`)) throw new Pm2DeployError(`A build is already running in ${dir}`);
  const refused = await notOwner(server, dir);
  if (refused) throw new Pm2DeployError(refused);

  // what is in the folder now — the branch checked out decides, not what the last sync saw
  const { stdout } = await exec(
    server,
    ['sh', '-c', 'ls -- "$1"; echo "---"; [ -r "$1/package.json" ] && cat -- "$1/package.json"; true', 'sh', dir],
    { timeout: 15_000, maxBuffer: 1024 * 1024 },
  );
  const [listing = '', json = ''] = stdout.split(/^---$/m);
  const files = listing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const steps = pm2DeploySteps(files, files.includes('package.json') ? json.trim() : null, app.processName);
  // the node the running process uses — builds and native modules must match it
  const nodeVersion = (await listPm2Processes(server)).find((process) => process.name === app.processName)?.nodeVersion;

  const deployment = await prisma.deployment.create({
    data: { applicationId: app.id, sourceId: app.sourceId, userId, status: 'BUILDING', deployLogs: `Build and restart in ${dir}\n` },
  });
  running.add(`${server.id}:${dir}`);
  // the page follows a deploying app; what it was comes back if the build fails
  await prisma.application.update({ where: { id: app.id }, data: { status: 'DEPLOYING' } });
  void run(server, dir, nodeVersion, app, steps, deployment.id).finally(() => running.delete(`${server.id}:${dir}`));
  return deployment.id;
}

async function run(
  server: SshTarget,
  dir: string,
  nodeVersion: string | undefined,
  app: { id: string; status: string },
  steps: Array<{ label: string; argv: string[] }>,
  deploymentId: string,
): Promise<void> {
  let log = `Build and restart in ${dir}${nodeVersion ? ` with node ${nodeVersion} (as pm2 runs it)` : ''}\n`;
  let dirty = false;
  // the row follows the log every couple of seconds, not every chunk
  const flush = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    void prisma.deployment.update({ where: { id: deploymentId }, data: { deployLogs: log.slice(-200_000) } }).catch(() => {});
  }, 2000);
  const write = (text: string) => {
    log += text;
    dirty = true;
  };

  try {
    for (const step of steps) {
      if (step.label === 'restart') await prisma.deployment.update({ where: { id: deploymentId }, data: { status: 'DEPLOYING' } });
      write(`\n$ ${step.argv.join(' ')}\n`);
      // the log streams through `write`; what exec keeps is only for its error message
      await exec(server, inDir(dir, nodeVersion, step.argv), { timeout: 30 * 60_000, maxBuffer: 1024 * 1024, onOutput: write });
    }
    clearInterval(flush);
    await prisma.deployment.update({ where: { id: deploymentId }, data: { status: 'SUCCESS', deployLogs: log.slice(-200_000) } });
    await prisma.application.update({ where: { id: app.id }, data: { status: 'RUNNING', lastDeployment: new Date() } });
  } catch (error: any) {
    clearInterval(flush);
    // the step's output is in the log already, streamed — only why it stopped
    write(`\n${String(error?.message || error).split('\n')[0]}\n`);
    // stopped before the restart: pm2 still runs what it ran — its output may be half rewritten
    write('\nStopped here — nothing after this step ran. pm2 was not restarted unless the log above says so.\n');
    await prisma.deployment.update({ where: { id: deploymentId }, data: { status: 'FAILED', deployLogs: log.slice(-200_000) } });
    // pm2 still runs what it ran before
    await prisma.application.update({ where: { id: app.id }, data: { status: app.status as AppStatus } }).catch(() => {});
  }
}

/**
 * A build the panel was running when it stopped: nothing follows it any more.
 * Its row says so and the app leaves "deploying" — pm2 still runs whatever it
 * ran. Called at startup; only imported apps, whose builds are these.
 */
export async function recoverPm2Deploys(): Promise<number> {
  const stale = await prisma.deployment.findMany({
    where: { status: { in: ['PENDING', 'BUILDING', 'DEPLOYING'] }, application: { runtime: { not: null } } },
    select: { id: true, applicationId: true, deployLogs: true },
  });
  for (const row of stale) {
    await prisma.deployment.update({
      where: { id: row.id },
      data: { status: 'FAILED', deployLogs: `${row.deployLogs ?? ''}\n\nInterrupted: the panel restarted while this ran. Check the site, then build again.\n` },
    });
    await prisma.application.updateMany({ where: { id: row.applicationId, status: 'DEPLOYING' }, data: { status: 'RUNNING' } });
  }
  return stale.length;
}
