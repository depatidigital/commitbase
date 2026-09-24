import path from 'path';
import type { AppStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { exec, type SshTarget } from '../lib/runner';
import { listPm2Processes } from './appSyncService';
import { PNPM_ALLOW_BUILDS, lockfileManager, preDeployOf } from '../lib/projectDetect';

/**
 * Build and restart an imported pm2 app where it lives: its own folder on its
 * own node, as the folder's owner — install (by its lockfile), build (its
 * package.json `build` script), `pm2 restart <name>`. There is no release
 * folder to build beside, so the site can err while the build rewrites its
 * output; the caller asked the user first. Runs in the background and writes
 * its log onto a deployment row as it goes.
 */

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

/** The package manager a folder's lockfile says (projectDetect lockfileManager). Pure. */
export function packageManager(files: string[]): PackageManager {
  return lockfileManager((name) => files.includes(name)) ?? 'npm';
}

/**
 * The steps, as argv — never a shell string, so nothing stored or typed
 * anywhere becomes a command. Install is skipped without a package.json;
 * migrations without Prisma; build without a `build` script. Pure.
 */
export function pm2DeploySteps(files: string[], packageJson: string | null, processName: string | null): Array<{ label: string; argv: string[] }> {
  const steps: Array<{ label: string; argv: string[] }> = [];
  if (packageJson !== null) {
    const manager = packageManager(files);
    // exactly the lockfile's versions, like a deploy — never a silent upgrade
    const install: Record<PackageManager, string[]> = {
      pnpm: ['pnpm', 'install', '--frozen-lockfile', PNPM_ALLOW_BUILDS],
      yarn: ['yarn', 'install', '--frozen-lockfile'],
      bun: ['bun', 'install', '--frozen-lockfile'],
      npm: files.includes('package-lock.json') ? ['npm', 'ci'] : ['npm', 'install'],
    };
    steps.push({ label: 'install', argv: install[manager] });
    // before the build (Next prerendering may query the tables) and the restart, like a deploy.
    // ponytail: always `migrate deploy` — with no prisma/migrations it only says so; the
    // db push fallback of a fresh deploy is not for a live database.
    const migrate = preDeployOf({ 'package.json': packageJson }, manager, true);
    if (migrate) steps.push({ label: 'migrate', argv: migrate.split(' ') });
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
  // a static site is its files: built is live, nothing to restart
  if (processName) steps.push({ label: 'restart', argv: ['pm2', 'restart', processName] });
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
  return (await startPm2DeployTracked(applicationId, userId)).deploymentId;
}

/** The same, with the run to wait on — true when every step went through. */
export async function startPm2DeployTracked(applicationId: string, userId: string): Promise<{ deploymentId: string; done: Promise<boolean> }> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: {
      id: true,
      name: true,
      runtime: true,
      processName: true,
      rootPath: true,
      serverId: true,
      sourceId: true,
      status: true,
      source: { select: { path: true } },
    },
  });
  const pm2 = app?.runtime === 'PM2' && !!app.processName;
  // an imported site served from disk builds where it is too: its output is what Caddy serves
  const onDisk = app?.runtime === 'CADDY_STATIC';
  if (!app || !app.rootPath || !(pm2 || onDisk)) {
    throw new Pm2DeployError('Only an app pm2 runs, or a site served from its folder, can be built here');
  }
  const server = app.serverId ? await prisma.server.findUnique({ where: { id: app.serverId } }) : null;
  if (!server) throw new Pm2DeployError('This pm2 app is not linked to a server — sync the apps again');
  // Where install and build run: a process — the root of the git checkout its
  // folder sits in (the sync's `git rev-parse --show-toplevel`: a monorepo's
  // lockfile and workspace), then its own folder; a static site — the project
  // its output sits in (web/ for web/dist), then the checkout.
  const candidates = [
    ...new Set((pm2 ? [app.source?.path, app.rootPath] : [path.posix.dirname(app.rootPath), app.source?.path]).filter((d): d is string => !!d)),
  ];
  const { stdout } = await exec(
    server,
    // the first with a package.json; none: the last (the process's folder) with nothing to install
    ['sh', '-c', 'for d; do if [ -r "$d/package.json" ]; then echo "$d"; ls -- "$d"; echo "---"; cat -- "$d/package.json"; exit 0; fi; last="$d"; done; echo "$last"; ls -- "$last"; echo "---"', 'sh', ...candidates],
    { timeout: 15_000, maxBuffer: 1024 * 1024 },
  );
  const [head = '', json = ''] = stdout.split(/^---$/m);
  const [dirLine = app.rootPath, ...listingLines] = head.split(/\r?\n/);
  const dir = dirLine.trim() || app.rootPath;
  const listing = listingLines.join('\n');
  if (running.has(`${server.id}:${dir}`)) throw new Pm2DeployError(`A build is already running in ${dir}`);
  const refused = await notOwner(server, dir);
  if (refused) throw new Pm2DeployError(refused);
  const listed = listing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const steps = pm2DeploySteps(listed, listed.includes('package.json') ? json.trim() : null, pm2 ? app.processName : null);
  // the node the running process uses — builds and native modules must match it
  const nodeVersion = pm2 ? (await listPm2Processes(server)).find((process) => process.name === app.processName)?.nodeVersion : undefined;

  const deployment = await prisma.deployment.create({
    data: { applicationId: app.id, sourceId: app.sourceId, userId, status: 'BUILDING', deployLogs: `Build and restart in ${dir}\n` },
  });
  running.add(`${server.id}:${dir}`);
  // the page follows a deploying app; what it was comes back if the build fails
  await prisma.application.update({ where: { id: app.id }, data: { status: 'DEPLOYING' } });
  const done = run(server, dir, nodeVersion, app, steps, deployment.id).finally(() => running.delete(`${server.id}:${dir}`));
  return { deploymentId: deployment.id, done };
}

/**
 * Build every imported app of a project where it lives, one after the other:
 * its sites' files first, then the processes — so an API restarts onto a
 * front end that is already built. A failed one does not stop the rest; each
 * has its own row. Returns the apps it will build, while it runs.
 * ponytail: two processes from one folder build it twice — group by folder if that time matters.
 */
export async function buildProject(sourceId: string, userId: string, only?: string[]): Promise<string[]> {
  const apps = await prisma.application.findMany({
    where: {
      sourceId,
      ...(only && { id: { in: only } }),
      rootPath: { not: null },
      OR: [{ runtime: 'CADDY_STATIC' }, { runtime: 'PM2', processName: { not: null } }],
    },
    select: { id: true, name: true, runtime: true },
    orderBy: { createdAt: 'asc' },
  });
  const ordered = [...apps.filter((a) => a.runtime === 'CADDY_STATIC'), ...apps.filter((a) => a.runtime === 'PM2')];
  void (async () => {
    for (const app of ordered) {
      try {
        await (await startPm2DeployTracked(app.id, userId)).done;
      } catch (error: any) {
        console.error(`Project build: ${app.name} not started:`, error?.message ?? error);
      }
    }
  })();
  return ordered.map((a) => a.name);
}

async function run(
  server: SshTarget,
  dir: string,
  nodeVersion: string | undefined,
  app: { id: string; status: string },
  steps: Array<{ label: string; argv: string[] }>,
  deploymentId: string,
): Promise<boolean> {
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
    return true;
  } catch (error: any) {
    clearInterval(flush);
    // the step's output is in the log already, streamed — only why it stopped
    write(`\n${String(error?.message || error).split('\n')[0]}\n`);
    // stopped before the restart: pm2 still runs what it ran — its output may be half rewritten
    write('\nStopped here — nothing after this step ran. pm2 was not restarted unless the log above says so.\n');
    await prisma.deployment.update({ where: { id: deploymentId }, data: { status: 'FAILED', deployLogs: log.slice(-200_000) } });
    // pm2 still runs what it ran before
    await prisma.application.update({ where: { id: app.id }, data: { status: app.status as AppStatus } }).catch(() => {});
    return false;
  }
}

/**
 * A build the panel was running when it stopped: nothing follows it any more.
 * Its row says so and the app leaves "deploying" — pm2 still runs whatever it
 * ran. Called at startup; only imported apps, whose builds are these.
 */
export async function recoverPm2Deploys(): Promise<number> {
  const stale = await prisma.deployment.findMany({
    where: { status: { in: ['PENDING', 'BUILDING', 'DEPLOYING'] } },
    select: { id: true, applicationId: true, deployLogs: true, application: { select: { runtime: true, activeReleaseId: true } } },
  });
  for (const row of stale) {
    await prisma.deployment.update({
      where: { id: row.id },
      data: { status: 'FAILED', deployLogs: `${row.deployLogs ?? ''}\n\nInterrupted: the panel restarted while this ran. Check the site, then build again.\n` },
    });
    // a pm2 app or one with a live release kept running; a first deploy left nothing up
    const status = row.application.runtime || row.application.activeReleaseId ? 'RUNNING' : 'ERROR';
    await prisma.application.updateMany({ where: { id: row.applicationId, status: { in: ['DEPLOYING', 'BUILDING'] } }, data: { status } });
  }
  return stale.length;
}
