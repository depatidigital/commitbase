import { prisma } from '../lib/prisma';
import { exec, type SshTarget } from '../lib/runner';

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

/** Runs `argv` in `dir` with nvm's node on the PATH — how these boxes install node. */
const inDir = (dir: string, argv: string[]) => [
  'sh',
  '-c',
  'for d in "$HOME"/.nvm/versions/node/*/bin; do PATH="$d:$PATH"; done; cd -- "$0" && exec "$@"',
  dir,
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

  const deployment = await prisma.deployment.create({
    data: { applicationId: app.id, sourceId: app.sourceId, userId, status: 'BUILDING', deployLogs: `Build and restart in ${dir}\n` },
  });
  running.add(`${server.id}:${dir}`);
  void run(server, dir, app, steps, deployment.id).finally(() => running.delete(`${server.id}:${dir}`));
  return deployment.id;
}

async function run(
  server: SshTarget,
  dir: string,
  app: { id: string; status: string },
  steps: Array<{ label: string; argv: string[] }>,
  deploymentId: string,
): Promise<void> {
  let log = `Build and restart in ${dir}\n`;
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
      await exec(server, inDir(dir, step.argv), { timeout: 30 * 60_000, maxBuffer: 0, onOutput: write });
    }
    clearInterval(flush);
    await prisma.deployment.update({ where: { id: deploymentId }, data: { status: 'SUCCESS', deployLogs: log.slice(-200_000) } });
    await prisma.application.update({ where: { id: app.id }, data: { status: 'RUNNING', lastDeployment: new Date() } });
  } catch (error: any) {
    clearInterval(flush);
    write(`\n${String(error?.stderr || error?.message || error).trim()}\n`);
    // stopped before the restart: pm2 still runs what it ran — its output may be half rewritten
    write('\nStopped here — nothing after this step ran. pm2 was not restarted unless the log above says so.\n');
    await prisma.deployment.update({ where: { id: deploymentId }, data: { status: 'FAILED', deployLogs: log.slice(-200_000) } });
  }
}
