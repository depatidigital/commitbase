import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import * as path from 'path';
import { Application, Deployment, Release } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { uploadBuildLog } from './s3Service';
import { configureCaddyForRuntimeApplication, configureCaddyForStaticApplication, configureCaddyForPhpApplication, staticRouteError } from './caddyService';
import { appUnit, appBuild, ensureOrgOnNode } from './orgProvisionService';
import { serverForApplication, appsOnServer } from '../lib/servers';
import type { AppWithOrg } from './systemdService';
import { ensureSiteBucket, uploadSiteDirectory } from './r2Service';
import { adoptRootFiles, discardFolder, inFolder, pruneStaticReleases, releaseFolder } from './staticReleaseService';
import { releasesDirFor, currentDirFor, sharedDirFor, sourcesDirFor, logsDirFor } from '../lib/appPaths';
import { appFsFor, appFsForDomain, type AppFs } from '../lib/appFs';
import { detectProject, nvmPreamble } from '../lib/projectDetect';
import { gitAuthFor } from '../lib/gitCredentials';
import { sealEnv } from '../lib/appEnv';
import { forwardTcp } from '../lib/runner';
import * as systemd from './systemdService';
import * as http from 'http';
import { cleanupAppReleases } from './appDiskService';

// Ports handed to runtime apps. Every app gets one for life; Caddy proxies to
// it on localhost. Apps must listen on $PORT — the health check enforces it.
const PORT_POOL_START = Number(process.env.APP_PORT_POOL_START || 20000);
const PORT_POOL_END = Number(process.env.APP_PORT_POOL_END || 29999);
const HEALTH_TIMEOUT_MS = Number(process.env.APP_HEALTH_TIMEOUT_MS || 60000);
// Builds are the memory hogs (next build ≈ 1-2 GB). One at a time by default.
const BUILD_CONCURRENCY = Math.max(1, Number(process.env.BUILD_CONCURRENCY || 1));

// ponytail: in-process locks. Fine for one backend; a DB row lock if the backend ever runs twice.
const deploying = new Set<string>();
// deploys a user asked to stop; checked between steps (cancelDeploy)
const cancelling = new Set<string>();

/** A deploy stopped on request — recorded as CANCELLED, not FAILED. */
class CancelledError extends Error {}
const throwIfCancelled = (applicationId: string) => {
  if (cancelling.has(applicationId)) throw new CancelledError('Deployment cancelled');
};
let running = 0;
const waiting: Array<() => void> = [];
async function withBuildSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= BUILD_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await fn();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

const NL = '\n';
// Every app path is on a Linux box (the app's node), so posix.
const join = path.posix.join;

/**
 * Run a command with stdout and stderr appended to a log file as they arrive,
 * so the log can be read while it runs. Rejects on a non-zero exit or when the
 * timeout kills it; the output is already in the file either way.
 * Local only — static builds on the panel.
 */
export function streamToLog(
  command: string,
  args: string[],
  logPath: string,
  timeoutMs: number,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(logPath, { flags: 'a' });
    const child = spawn(command, args, options);
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });

    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      out.end();
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      out.end(() =>
        code === 0
          ? resolve()
          : reject(new Error(signal ? `Build killed (${signal}) after ${timeoutMs / 60000} minutes` : `Build exited with code ${code}`))
      );
    });
  });
}

/**
 * One .env line that Node's loaders (process.loadEnvFile, dotenv) read back as
 * exactly `value`. Single quotes are literal there — no escapes to get wrong —
 * so they are used whenever the value allows; a newline needs double quotes.
 * Pure. ponytail: a value holding both a newline and a double quote is written
 * with backticks (dotenv reads them; Node's own loader may not).
 */
export function dotenvLine(key: string, value: string): string {
  if (!/[\r\n']/.test(value)) return `${key}='${value}'`;
  if (!/["\r]/.test(value)) return `${key}="${value.replace(/\n/g, '\\n')}"`;
  return `${key}=\`${value}\``;
}

/** Git in the sources tree. safe.directory: after the first deploy the tree belongs to the tenant user. */
const gitIn = (afs: AppFs, sourcesDir: string, args: string[], env?: Record<string, string>) =>
  afs.run(['git', '-c', `safe.directory=${sourcesDir}`, ...args], { cwd: sourcesDir, timeout: 600_000, ...(env && { env }) });

export interface DeploymentConfig {
  application: Application;
  deployment: Deployment;
  envVars?: Record<string, string>;
}

export interface BuildResult {
  success: boolean;
  error?: string;
  releaseDir?: string;
  docroot?: string; // PHP: document root relative to the release
}

export interface DeployResult {
  success: boolean;
  error?: string;
  buildLogs?: string;
  deployLogs?: string;
  /** Failed, but the previous release was put back and is serving. */
  rolledBack?: boolean;
  /** Stopped on request before it went live — whatever served before still does. */
  cancelled?: boolean;
}

export interface StartResult {
  success: boolean;
  logs: string;
  error?: string;
}

/**
 * Application deployment.
 *
 * Apps build and run natively on their own node: each one is a systemd unit
 * owned by its organization's OS user, inside that org's cgroup slice on that
 * node (see systemdService and orgProvisionService). Every file and command
 * goes through AppFs, which is that node over SSH — or the panel's own disk for
 * static sites (lib/appFs.ts).
 */
export class DeploymentService {
  /** Load an application with the organization the runtime needs. */
  private async appWithOrg(domain: string) {
    return prisma.application.findFirst({
      where: { domain },
      include: { organization: { select: { slug: true } } },
    });
  }

  /** Create the application's tree (logs/, sources/) where it belongs. */
  async prepareAppDirectory(applicationId: string): Promise<AppFs> {
    const afs = await appFsFor(applicationId);
    try {
      await afs.mkdir(logsDirFor(afs.appDir));
      await afs.mkdir(sourcesDirFor(afs.appDir));
      return afs;
    } catch (error: any) {
      throw new Error(`Failed to prepare app directory: ${error?.stderr || error?.message || error}`);
    }
  }

  /**
   * Clone or pull the repository into sources/.
   */
  async syncRepository(
    afs: AppFs,
    repository: string,
    branch: string = 'main',
    gitAccountId: string | null = null
  ): Promise<string> {
    const sourcesDir = sourcesDirFor(afs.appDir);
    try {
      // Private repositories need the connected account's token. It reaches git
      // as an environment variable read back by a one-shot credential helper,
      // so it never lands in .git/config, in `ps`, or in this log.
      const auth = await gitAuthFor(gitAccountId);

      if (await afs.exists(join(sourcesDir, '.git'))) {
        console.log(`Pulling latest changes for ${repository} on branch ${branch}`);
        await gitIn(afs, sourcesDir, [...auth.args, 'fetch', 'origin'], auth.env);
        await gitIn(afs, sourcesDir, ['reset', '--hard', `origin/${branch}`]);
      } else {
        console.log(`Cloning repository ${repository} on branch ${branch}`);
        await afs.run(['git', ...auth.args, 'clone', '-b', branch, '--', repository, sourcesDir], {
          timeout: 600_000,
          env: auth.env,
        });
      }

      return sourcesDir;
    } catch (error: any) {
      throw new Error(`Failed to sync repository: ${error?.stderr || error?.message || error}`);
    }
  }

  /**
   * Give the app a port from the pool, once. Taken ports come from the DB
   * (including imported inventory) and a check on the node catches anything
   * else listening there. A port already assigned is kept — the running
   * release holds it, which is not a conflict.
   */
  private async allocatePort(application: Application, afs: AppFs): Promise<number> {
    if (application.port) return application.port;

    const rows = await prisma.application.findMany({
      where: { port: { not: null } },
      select: { port: true },
    });
    const taken = new Set(rows.map((r) => r.port as number));

    for (let port = PORT_POOL_START; port <= PORT_POOL_END; port++) {
      if (taken.has(port)) continue;
      if (await afs.portInUse(port)) continue;
      await prisma.application.update({ where: { id: application.id }, data: { port } });
      application.port = port as any;
      return port;
    }
    throw new Error(`No free port left in ${PORT_POOL_START}-${PORT_POOL_END}`);
  }

  private getDefaultPort(type: string): number {
    return systemd.defaultPort(type);
  }

  /** One HTTP request to the app's port on its own box. Any response means it is up. */
  private async probe(afs: AppFs, port: number): Promise<boolean> {
    let createConnection: (() => any) | undefined;
    if (afs.node) {
      // the app listens on the node's loopback; reach it through the SSH connection
      const stream = await forwardTcp(afs.node, '127.0.0.1', port).catch(() => null);
      if (!stream) return false;
      createConnection = () => stream;
    }
    return new Promise<boolean>((resolve) => {
      // No `agent: false` with a tunnel: that makes Node build a fresh Agent and
      // ignore createConnection — the probe then dialled the panel's own
      // loopback, was refused every time, and failed healthy apps on the node.
      const req = http.get(
        { host: '127.0.0.1', port, path: '/', timeout: 3000, ...(createConnection ? { createConnection } : { agent: false }) },
        (res) => {
          res.resume();
          req.destroy();
          resolve(true);
        },
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  /** Poll until something answers HTTP on the port. */
  private waitForHealthy(afs: AppFs, port: number, timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const tick = async () => {
        if (await this.probe(afs, port)) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 1000);
      };
      tick();
    });
  }

  /** Point `current` at a release. Symlink + rename, so the switch is atomic. */
  private async activateRelease(afs: AppFs, releaseDir: string): Promise<string | null> {
    const current = currentDirFor(afs.appDir);
    const previous = await afs.readlink(current).catch(() => null);
    const tmp = current + '.tmp';
    await afs.rm(tmp, { force: true });
    await afs.symlink(releaseDir, tmp);
    await afs.rename(tmp, current);
    return previous;
  }

  /**
   * Release trees outside the rollback window — failed, cancelled, or pushed
   * out by newer builds — go before a build, and their rows with them
   * (appDiskService). Each carries node_modules and .next, so they add up.
   */
  private async removeOrphanReleases(afs: AppFs, applicationId: string): Promise<void> {
    await cleanupAppReleases(afs, applicationId);
  }

  /**
   * Build a fresh release: copy sources/ into releases/<stamp>, install and
   * build there. The tree that is serving is never touched, and rollback is a
   * symlink away. The tree is handed to the tenant user by cb-app-unit install.
   */
  async runBuild(
    afs: AppFs,
    application: Application,
    deployment: Deployment,
    envVars: Record<string, string> = {}
  ): Promise<BuildResult> {
    const { appDir } = afs;
    const sourcesDir = sourcesDirFor(appDir);
    const logsDir = logsDirFor(appDir);
    await afs.mkdir(logsDir);
    const buildLogPath = join(logsDir, 'build.log');
    const log = (line: string) => afs.appendFile(buildLogPath, line + NL);
    const uploadLog = () =>
      afs.readFile(buildLogPath).then((body) => uploadBuildLog(body, application.id, deployment.id)).catch(() => {});
    // the release this build is making — removed again if it fails
    let madeRelease: string | null = null;

    try {
      if (systemd.needsUnit(application.type)) await this.allocatePort(application, afs);
      await this.removeOrphanReleases(afs, application.id);

      await afs.writeFile(buildLogPath, `[${new Date().toISOString()}] BUILD STARTED` + NL);

      const detected = await detectProject(sourcesDir, afs.readText);
      await log(`Detected: ${detected.label} (${detected.packageManager})`);

      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
      const releaseDir = join(releasesDirFor(appDir), stamp);
      await afs.mkdir(releaseDir);
      madeRelease = releaseDir;
      // ponytail: full copy per release, tar excludes the junk. Hardlink node_modules from the previous release if installs get slow.
      await afs.run(
        ['sh', '-c', 'tar -C "$1" --exclude=./node_modules --exclude=./.next --exclude=./.git -cf - . | tar -C "$2" -xf -', 'sh', sourcesDir, releaseDir],
        { timeout: 300_000 },
      );

      if (detected.framework === 'nextjs') {
        // Next's build cache survives across releases — big win on rebuilds.
        const cache = join(sharedDirFor(appDir), 'next-cache');
        await afs.mkdir(cache);
        await afs.mkdir(join(releaseDir, '.next'));
        await afs.symlink(cache, join(releaseDir, '.next', 'cache'));
      }

      const has = (f: string) => afs.exists(join(releaseDir, f));
      const steps: string[] = [];

      // the app's own install command when set, else the detected one
      const installCommand = application.installCommand || detected.installCommand;

      if (detected.type === 'PHP') {
        if (installCommand) {
          if (await this.reuseInstalled(afs, releaseDir, 'composer.lock', 'vendor')) {
            await log('vendor: composer.lock unchanged, hardlinked from the previous release');
          } else {
            steps.push(installCommand);
          }
        }
        // Laravel and friends read .env from the app root. The platform's env
        // vars win over whatever the repository shipped.
        if (detected.framework === 'laravel' && !envVars.APP_KEY) {
          // Laravel refuses to boot without one. Generate once and keep it on
          // the app so sessions survive the next deploy.
          envVars.APP_KEY = 'base64:' + require('crypto').randomBytes(32).toString('base64');
          await prisma.application.update({ where: { id: application.id }, data: { envVars: sealEnv(envVars) } });
          await log('Generated APP_KEY and saved it to the app env');
        }
        const entries = Object.entries(envVars).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
        if (entries.length > 0) {
          const shipped = await afs.readText(join(releaseDir, '.env')).catch(() => '');
          const kept = shipped.split(/\r?\n/).filter((line) => !entries.some(([k]) => line.startsWith(k + '=')));
          const own = entries.map(([k, v]) => `${k}="${String(v).replace(/(["\\$])/g, '\\$1')}"`);
          await afs.writeFile(join(releaseDir, '.env'), [...kept, ...own].join(NL) + NL);
        }
      } else if (await has('package.json')) {
        // The env is exported to the build, but some tools read the file
        // itself: Prisma 7's prisma.config.ts loads '.env' and fails on
        // ENOENT without it, and so does anything calling loadEnvFile().
        // The platform's values win over a .env the repository shipped.
        const envEntries = Object.entries(envVars).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
        if (envEntries.length > 0) {
          const shipped = await afs.readText(join(releaseDir, '.env')).catch(() => '');
          const kept = shipped.split(/\r?\n/).filter((line) => line.trim() && !envEntries.some(([k]) => line.startsWith(k + '=')));
          // as readable as build.sh, which already carries the same values
          await afs.writeFile(join(releaseDir, '.env'), [...kept, ...envEntries.map(([k, v]) => dotenvLine(k, String(v)))].join(NL) + NL, { mode: 0o660 });
        }

        const lock = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', bun: 'bun.lock' }[detected.packageManager];
        if (lock && (await this.reuseInstalled(afs, releaseDir, lock, 'node_modules'))) {
          await log('node_modules: lockfile unchanged, hardlinked from the previous release');
        } else {
          steps.push(installCommand);
        }
      }
      if (await has('requirements.txt')) steps.push('python3 -m pip install --user -r requirements.txt');
      // every build, even with node_modules reused: the client lands in the release tree
      if (detected.generateCommand) steps.push(detected.generateCommand);
      // Migrations and the like: before the build, which may query the tables
      // (Next prerendering), in the same script and env. A failure leaves the
      // old release live — but a migration that ran and a build that then
      // failed leave the old release on the new schema.
      if (application.preDeployCommand) steps.push(application.preDeployCommand);
      const buildCommand = application.buildCommand || detected.buildCommand;
      if (buildCommand) steps.push(buildCommand);

      if (steps.length > 0) {
        // One script for the whole build, so it can run under systemd-run in
        // its own cgroup. NEXT_PUBLIC_* and friends are baked in at build time,
        // so the app's env is exported here. NODE_ENV stays unset: production
        // would skip the devDependencies most build tools live in.
        const q = (v: string) => `'${String(v).replace(/'/g, `'\\''`)}'`;
        // CI=1: no prompt can ever wait for an answer. pnpm 10 blocks
        // dependencies' build scripts (prisma engines, esbuild, sharp) until
        // `pnpm approve-builds` is answered — interactively — and in CI just
        // skips them, so the app breaks later instead. The build is already
        // the app's own code in its build cgroup as the build user; its
        // dependencies' scripts are no less trusted than that.
        const exports = Object.entries({
          ...envVars,
          PORT: String(application.port || ''),
          CI: '1',
          NEXT_TELEMETRY_DISABLED: '1',
          npm_config_dangerously_allow_all_builds: 'true',
        })
          .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
          .map(([k, v]) => `export ${k}=${q(v)}`);
        const script = [
          '#!/bin/bash',
          '# Generated by Larika for one deploy. Overwritten on the next.',
          'set -euo pipefail',
          'unset NODE_ENV',
          ...nvmPreamble(detected.nodeVersion, true),
          'echo "node $(node -v 2>/dev/null || echo missing) at $(command -v node || true)"',
          ...exports,
          `cd ${q(releaseDir)}`,
          ...steps.flatMap((step) => [`echo`, `echo ${q('$ ' + step)}`, step]),
          '',
        ].join(NL);
        const buildScript = join(appDir, 'build.sh');
        await afs.rm(buildScript, { force: true }); // may be owned by the tenant after chown
        await afs.writeFile(buildScript, script, { mode: 0o660 });

        const slug = (await prisma.application.findUnique({
          where: { id: application.id },
          select: { organization: { select: { slug: true } } },
        }))?.organization?.slug;

        // there is no building on the panel: appFsFor only hands out a node for tenant apps
        if (!afs.node || !slug) throw new Error('This app has no organization node to build on');
        {
          // On the node, in the build cgroup, as the unprivileged build user.
          // Output is appended to build.log as it prints — serially, so chunks
          // land in order — which is what the live log view follows.
          let appending: Promise<unknown> = Promise.resolve();
          const onOutput = (text: string) => {
            appending = appending.then(() => afs.appendFile(buildLogPath, text)).catch(() => {});
          };
          try {
            await appBuild(slug, application.id, onOutput);
          } finally {
            await appending;
          }
        }
      }

      await log(NL + `[${new Date().toISOString()}] BUILD COMPLETED`);
      await uploadLog();
      return { success: true, releaseDir, docroot: detected.outputDir || '.' };
    } catch (error: any) {
      const message = error.stderr || error.message || String(error);
      await log(NL + `[${new Date().toISOString()}] BUILD FAILED:` + NL + message).catch(() => {});
      await uploadLog();
      // a failed build is never switched to, and node_modules is only ever
      // reused from the live release — its tree is dead weight. The log stays.
      if (madeRelease) await afs.rm(madeRelease, { recursive: true, force: true }).catch(() => {});
      return { success: false, error: message };
    }
  }

  /**
   * Same lockfile as the release that is live → hardlink its node_modules (or
   * vendor/) and skip the install. Saves the disk of a full copy and most of
   * the build time. Hardlinks are safe here: both releases belong to the same
   * tenant user.
   */
  private async reuseInstalled(afs: AppFs, releaseDir: string, lock: string, dir: string): Promise<boolean> {
    const previous = await afs.readlink(currentDirFor(afs.appDir)).catch(() => null);
    if (!previous) return false;
    const [a, b] = await Promise.all([
      afs.readFile(join(previous, lock)).catch(() => null),
      afs.readFile(join(releaseDir, lock)).catch(() => null),
    ]);
    if (!a || !b || !a.equals(b)) return false;
    const prevDir = join(previous, dir);
    if (!(await afs.isDirectory(prevDir))) return false;
    // ponytail: cp -al, GNU coreutils. Fall back to a real install if it fails.
    return afs
      .run(['cp', '-al', '--', prevDir, join(releaseDir, dir)], { timeout: 300_000 })
      .then(() => true)
      .catch(() => false);
  }

  /**
   * PHP apps have no unit: the org's PHP-FPM pool serves them. Publishing is
   * handing the tree to the tenant user and pointing Caddy at the docroot.
   */
  private async publishPhp(application: AppWithOrg, afs: AppFs, docroot: string): Promise<boolean> {
    const slug = application.organization?.slug;
    if (!slug) throw new Error('PHP apps need an organization (the FPM pool is per org)');

    const deployLogPath = join(logsDirFor(afs.appDir), 'deploy.log');
    await appUnit('chown', slug, application.id);

    // The pool socket lives on the org's node, next to its Caddy — not on the panel.
    const node = afs.node ?? (await serverForApplication(application.id));
    const socketDir = process.env.PHP_FPM_SOCKET_DIR || '/run/php';
    const sockets = (await afs.readdir(socketDir).catch(() => [] as string[])).filter((n) =>
      new RegExp(`^php[0-9.]+-fpm-cb-${slug}\\.sock$`).test(n)
    );
    if (sockets.length === 0) {
      await afs.appendFile(deployLogPath, `No PHP-FPM pool socket for this organization in ${socketDir}. Re-provision the organization with PHP-FPM installed.` + NL);
      return false;
    }
    const socket = join(socketDir, sockets.sort().reverse()[0] as string);
    const root = join(currentDirFor(afs.appDir), docroot);

    await configureCaddyForPhpApplication(node, application.domain, root, socket);
    await afs.appendFile(deployLogPath, `PHP: ${root} via ${socket}` + NL);
    return true;
  }

  /** Hostnames that should have a route right now — what the watchdog compares against. */
  async expectedCaddyHosts(serverId?: string): Promise<string[]> {
    const apps = await prisma.application.findMany({
      where: {
        status: 'RUNNING',
        runtime: null,
        ...(serverId && appsOnServer(serverId)),
      },
      select: { domain: true },
    });
    return apps.map((app) => app.domain);
  }

  /**
   * Push every running app's route into Caddy again. Routes live in Caddy's
   * memory; a `caddy reload` from the Caddyfile drops them. Called at backend
   * start, so "restart larika" is the recovery.
   */
  async reapplyCaddyRoutes(): Promise<{ applied: number; failed: number }> {
    const apps = await prisma.application.findMany({
      where: { status: 'RUNNING', runtime: null },
      include: { organization: { select: { slug: true } } },
    });
    let applied = 0;
    let failed = 0;
    for (const app of apps) {
      try {
        const node = await serverForApplication(app.id);
        if (app.type === 'STATIC') {
          await configureCaddyForStaticApplication(node, app.id, app.domain, app.staticOrigin);
        } else if (app.type === 'PHP') {
          const afs = await appFsFor(app.id);
          const detected = await detectProject(currentDirFor(afs.appDir), afs.readText);
          if (!(await this.publishPhp(app, afs, detected.outputDir || '.'))) throw new Error('no FPM socket');
        } else if (app.port) {
          await configureCaddyForRuntimeApplication(node, app.domain, app.port);
        } else {
          continue;
        }
        applied += 1;
      } catch (error: any) {
        failed += 1;
        console.error(`Caddy route for ${app.domain} not re-applied: ${error?.message || error}`);
      }
    }
    return { applied, failed };
  }

  /**
   * (Re)install and start the unit for an application, by hostname.
   */
  async startApplication(domain: string): Promise<boolean> {
    let afs: AppFs | null = null;
    const deployLog = (line: string) =>
      afs ? afs.appendFile(join(logsDirFor(afs.appDir), 'deploy.log'), line + NL).catch(() => {}) : Promise.resolve();

    try {
      const application = await this.appWithOrg(domain);
      if (!application) {
        throw new Error('Application not found for domain');
      }

      afs = await appFsFor(application.id);
      await afs.mkdir(logsDirFor(afs.appDir));
      await deployLog(`[${new Date().toISOString()}] DEPLOYMENT STARTED`);

      let started = await systemd.startApplication(application);

      if (systemd.needsUnit(application.type)) {
        const port = application.port || this.getDefaultPort(application.type);
        // what the unit runs, as run.sh has it — the start command after detection
        const run = await afs.readText(join(afs.appDir, 'run.sh')).catch(() => '');
        const lines = run.split(NL);
        const cdLine = lines.find((line) => line.startsWith('cd '));
        const execLine = lines.find((line) => line.startsWith('exec '));
        if (execLine) await deployLog(`Starting: ${execLine.slice(5)}  (PORT=${port}${cdLine ? `, in ${cdLine.slice(3)}` : ''})`);

        if (started) {
          await deployLog(`Waiting for the app to answer on 127.0.0.1:${port}`);
          started = await this.waitForHealthy(afs, port);
          if (!started) {
            await deployLog(`Nothing answered on port ${port} within ${HEALTH_TIMEOUT_MS / 1000}s. The app must listen on $PORT (${port}).`);
          }
        } else {
          await deployLog('The unit did not stay up.');
        }

        // the app's own words on why — without them a failed start says nothing
        if (!started) {
          const unit = await systemd.getStatus(application);
          await deployLog(`Unit: ${unit === 'RUNNING' ? 'running' : unit === 'UNKNOWN' ? 'unknown (the node did not answer)' : 'not running (crashed or exited)'}`);
          const logsDir = logsDirFor(afs.appDir);
          for (const name of ['error.log', 'out.log']) {
            const tail = await this.tailLog(afs, join(logsDir, name), 30, name);
            await deployLog(`--- last lines of logs/${name} ---` + NL + (tail.trim() || '(empty)'));
          }
        }
      }

      await deployLog(`[${new Date().toISOString()}] DEPLOYMENT ${started ? 'COMPLETED' : 'FAILED'}`);
      return started;
    } catch (error: any) {
      const message = error?.stderr || error?.message || String(error);
      await deployLog(`[${new Date().toISOString()}] DEPLOYMENT FAILED:` + NL + message);
      return false;
    }
  }

  /**
   * Activate a release. The sources tree already on disk is the release, so
   * this is a unit reinstall and restart.
   */
  async startRelease(application: Application, release: Release): Promise<boolean> {
    if (!application.domain) {
      throw new Error('Application domain is required for release start');
    }

    const afs = await appFsFor(application.id);
    await afs.mkdir(logsDirFor(afs.appDir));
    await afs.appendFile(join(logsDirFor(afs.appDir), 'deploy.log'), `[${new Date().toISOString()}] RELEASE STARTED: ${release.id}` + NL);

    if (release.path) {
      if (!(await afs.isDirectory(release.path))) throw new Error(`Release directory is gone: ${release.path}`);
      await this.activateRelease(afs, release.path);
    }

    return this.startApplication(application.domain);
  }

  async stopApplication(domain?: string): Promise<boolean> {
    try {
      if (!domain) return false;
      const application = await this.appWithOrg(domain);
      if (!application) return false;
      await systemd.stopApplication(application);
      return true;
    } catch (error) {
      console.error('Failed to stop application:', error);
      return false;
    }
  }

  async restartApplication(domain?: string): Promise<boolean> {
    try {
      if (!domain) return false;
      const application = await this.appWithOrg(domain);
      if (!application) return false;
      await systemd.restartApplication(application);
      return true;
    } catch (error) {
      console.error('Failed to restart application:', error);
      return false;
    }
  }

  /**
   * Application stdout, tailed from the unit's log file.
   */
  async getApplicationLogs(domain: string, lines: number = 100): Promise<string> {
    return this.getApplicationLogsFromFiles(domain, 'out', lines);
  }

  /** True while a deploy for this application is in flight. */
  isDeploying(applicationId: string): boolean {
    return deploying.has(applicationId);
  }

  /**
   * Full deployment process. One deploy per app at a time, and at most
   * BUILD_CONCURRENCY builds on the box.
   */
  async deploy(config: DeploymentConfig): Promise<DeployResult> {
    const id = config.application.id;
    if (deploying.has(id)) return { success: false, error: 'A deployment is already in progress for this application' };
    deploying.add(id);
    try {
      return await withBuildSlot(() => this.deployInner(config));
    } finally {
      deploying.delete(id);
      cancelling.delete(id);
    }
  }

  /**
   * Stop a running deploy. Between steps it notices on its own; a build in
   * progress on the node is stopped outright (its transient cb-build unit).
   * Once the new release is being switched in it is too late — that finishes,
   * so there is never half a switch. False when nothing is deploying.
   */
  async cancelDeploy(applicationId: string): Promise<boolean> {
    if (!deploying.has(applicationId)) return false;
    cancelling.add(applicationId);
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      select: { type: true, organization: { select: { slug: true } } },
    });
    // static builds run on the panel and stop at the next step instead
    if (app && app.type !== 'STATIC' && app.organization?.slug) {
      await appUnit('cancel-build', app.organization.slug, applicationId).catch((error: any) =>
        console.error(`Could not stop the build of ${applicationId}:`, error?.message ?? error),
      );
    }
    return true;
  }

  private async deployInner(config: DeploymentConfig): Promise<DeployResult> {
    const { application, deployment, envVars = {} } = config;
    let commitSha: string | undefined;

    try {
      console.log(`Starting deployment for application: ${application.name}`);

      await prisma.deployment.update({
        where: { id: deployment.id },
        data: { status: 'BUILDING' },
      });

      // The org has to exist on this app's node before anything lands there —
      // provisioned lazily, on the nodes it actually uses. A no-op once done.
      if (application.organizationId && application.type !== 'STATIC') {
        const node = await serverForApplication(application.id);
        await ensureOrgOnNode(application.organizationId, node.id, { userId: deployment.userId, trigger: 'deploy' });
      }
      throwIfCancelled(application.id);

      const afs = await this.prepareAppDirectory(application.id);
      const { appDir } = afs;

      const logsDir = logsDirFor(appDir);
      const buildLogPath = join(logsDir, 'build.log');
      const deployLogPath = join(logsDir, 'deploy.log');
      const sourcesDir = sourcesDirFor(appDir);
      const readLog = (file: string, missing: string) =>
        afs.readText(file).then((text) => (text.trim() ? text : missing), () => missing);
      const uploadLog = () =>
        afs.readFile(buildLogPath).then((body) => uploadBuildLog(body, application.id, deployment.id)).catch(() => {});

      // Fresh logs for a fresh deployment
      await afs.writeFile(buildLogPath, '');
      await afs.writeFile(deployLogPath, '');

      if (application.repository) {
        const branch = application.branch || 'main';
        await this.syncRepository(afs, application.repository, branch, application.gitAccountId);
        commitSha = await gitIn(afs, sourcesDir, ['rev-parse', 'HEAD'])
          .then(({ stdout }) => stdout.trim())
          .catch(() => undefined);
        // what the history row says: the commit's subject line, not just when
        const commitMessage = await gitIn(afs, sourcesDir, ['log', '-1', '--format=%s'])
          .then(({ stdout }) => stdout.trim() || undefined)
          .catch(() => undefined);
        await prisma.deployment.update({
          where: { id: deployment.id },
          data: { commitHash: commitSha ?? null, commitMessage: commitMessage ?? null },
        });
      }
      throwIfCancelled(application.id);

      if (application.type === 'STATIC') {
        // Static sites build on the panel (AppFs is local for them) and are
        // served from R2, so nothing here touches a node except the route.
        // Uploaded static sites already live in object storage — a redeploy has
        // nothing to build, so keep the deployment green instead of running a
        // build command against an empty sources tree.
        const prebuilt = !application.repository && !application.buildCommand;

        if (prebuilt) {
          await afs.appendFile(buildLogPath, `[${new Date().toISOString()}] UPLOADED SOURCES — no build step` + NL);
          await uploadLog();
          const buildLogs = await readLog(buildLogPath, 'Build logs not available');

          // no origin = the files never made it to a bucket (the upload failed
          // or never ran); there is nothing to serve, so do not report green
          if (!(application as any).staticOrigin) {
            const message = 'No uploaded files for this site yet — upload the site files again';
            return { success: false, error: message, buildLogs, deployLogs: message };
          }

          // the files are fine, but without its route the site is down — say
          // so instead of reporting green. Redeploying retries just this step.
          try {
            await configureCaddyForStaticApplication(
              await serverForApplication(application.id),
              application.id,
              application.domain,
              (application as any).staticOrigin
            );
          } catch (error: any) {
            const message = staticRouteError(error);
            return { success: false, error: message, buildLogs, deployLogs: message };
          }

          await prisma.deployment.update({
            where: { id: deployment.id },
            data: {
              status: 'SUCCESS',
              buildLogs,
              deployLogs: 'Uploaded files are already served from Cloudflare R2',
            },
          });

          await prisma.application.update({
            where: { id: application.id },
            data: { status: 'RUNNING', lastDeployment: new Date() },
          });

          return {
            success: true,
            buildLogs,
            deployLogs: 'Uploaded files are already served from Cloudflare R2',
          };
        }

        // NODE_ENV stays unset: production would make the install skip the
        // devDependencies that vite / react-scripts live in
        const staticBuildEnv = {
          ...process.env,
          ...envVars,
        };

        try {
          await afs.appendFile(buildLogPath, `[${new Date().toISOString()}] STATIC BUILD STARTED` + NL);

          // Same detection the create screen showed: install before building,
          // take the framework's output folder, and let a plain HTML repo
          // (no package.json, no build) ship as-is.
          const detected = await detectProject(sourcesDir, afs.readText);
          const hasPackageJson = await afs.exists(join(sourcesDir, 'package.json'));
          const steps = [
            hasPackageJson ? detected.installCommand : '',
            application.buildCommand || detected.buildCommand || '',
          ].filter(Boolean);

          await afs.appendFile(buildLogPath, `Detected: ${detected.label}` + NL);

          if (steps.length > 0) {
            // streamed into build.log as it prints, so the app page can follow it
            // ponytail: tenant build code on the panel as the backend user. Move
            // static builds into a node's build cgroup if untrusted tenants ship static sites.
            await afs.appendFile(buildLogPath, `$ ${steps.join(' && ')}` + NL);
            await streamToLog('sh', ['-c', steps.join(' && ')], buildLogPath, 600000, {
              cwd: sourcesDir,
              env: staticBuildEnv,
            });
            await afs.appendFile(buildLogPath, NL + `[${new Date().toISOString()}] STATIC BUILD COMPLETED` + NL);
          } else {
            await afs.appendFile(buildLogPath, 'No build step — publishing the repository as-is' + NL);
          }

          const distCandidates = [detected.outputDir, 'dist', 'build', 'out'].filter(
            (candidate): candidate is string => Boolean(candidate)
          );
          let distDir: string | null = null;
          for (const candidate of distCandidates) {
            const candidatePath = join(sourcesDir, candidate);
            if (await afs.exists(candidatePath)) {
              distDir = candidatePath;
              break;
            }
          }

          if (!distDir) {
            throw new Error(`Static build directory not found (looked for ${distCandidates.join(', ')})`);
          }

          // into a fresh release folder; the serving one is not touched until
          // the route moves (services/staticReleaseService.ts)
          const previousOrigin: string | null = (application as any).staticOrigin ?? null;
          const { bucket, origin } = await ensureSiteBucket(application.domain);
          await adoptRootFiles(application as any);
          const folder = releaseFolder(deployment.id);
          try {
            await uploadSiteDirectory(inFolder(bucket, folder), distDir);
          } catch (error) {
            await discardFolder(bucket, folder);
            throw error;
          }

          const release = await prisma.release.create({
            data: { applicationId: application.id, status: 'READY', path: folder, commitSha: commitSha ?? null, deploymentId: deployment.id },
          });
          const pointer = { staticBucket: bucket, staticOrigin: inFolder(origin, folder), activeReleaseId: release.id };

          await uploadLog();
          const buildLogs = await readLog(buildLogPath, 'Build logs not available');

          try {
            await configureCaddyForStaticApplication(
              await serverForApplication(application.id),
              application.id,
              application.domain,
              pointer.staticOrigin
            );
          } catch (error: any) {
            const message = staticRouteError(error);
            // nothing served before: point at the build anyway so a republish
            // retries only the route; otherwise the previous release serves on
            if (!previousOrigin) await prisma.application.update({ where: { id: application.id }, data: pointer });
            return { success: false, error: message, buildLogs, deployLogs: message, rolledBack: !!previousOrigin };
          }

          const deployLogs = `Static site deployed to Cloudflare R2 (${pointer.staticOrigin})`;
          await prisma.deployment.update({
            where: { id: deployment.id },
            data: { status: 'SUCCESS', buildLogs, deployLogs },
          });

          await prisma.application.update({
            where: { id: application.id },
            data: { ...pointer, status: 'RUNNING', lastDeployment: new Date() },
          });
          await pruneStaticReleases(application.id);

          return { success: true, buildLogs, deployLogs };
        } catch (error: any) {
          const message = error.stderr || error.message || String(error);
          await afs.appendFile(buildLogPath, `[${new Date().toISOString()}] STATIC BUILD FAILED:` + NL + message + NL + NL).catch(() => {});
          await uploadLog();

          const buildLogs = await readLog(buildLogPath, 'Build logs not available');

          await prisma.deployment.update({
            where: { id: deployment.id },
            data: {
              status: 'FAILED',
              buildLogs,
            },
          });

          return {
            success: false,
            error: message,
            buildLogs,
          };
        }
      }

      const buildResult = await this.runBuild(afs, application, deployment, envVars);
      // a stopped build fails — but that failure is the cancel, not the code;
      // and a build that finished still does not go live once cancel was asked
      throwIfCancelled(application.id);
      const buildLogs = await readLog(buildLogPath, 'Build logs not available');

      if (!buildResult.success) {
        await prisma.deployment.update({
          where: { id: deployment.id },
          data: {
            status: 'FAILED',
            buildLogs,
          },
        });

        return {
          success: false,
          error: buildResult.error || 'Build failed',
          buildLogs,
        };
      }

      await prisma.deployment.update({
        where: { id: deployment.id },
        data: {
          status: 'DEPLOYING',
          buildLogs,
        },
      });

      const previousRelease = await this.activateRelease(afs, buildResult.releaseDir!);
      const startResult =
        application.type === 'PHP'
          ? await this.publishPhp((await this.appWithOrg(application.domain))!, afs, buildResult.docroot || '.')
          : await this.startApplication(application.domain);

      let rolledBack = false;
      if (!startResult && previousRelease) {
        // Put the last good release back so the site stays up.
        await afs.appendFile(deployLogPath, `Rolling back to ${previousRelease}` + NL);
        await this.activateRelease(afs, previousRelease);
        rolledBack = await this.startApplication(application.domain).catch(() => false);
        await afs.rm(buildResult.releaseDir!, { recursive: true, force: true }).catch(() => {});
      }

      const deployLogs = await readLog(deployLogPath, 'Deploy logs not available');

      if (!startResult) {
        await prisma.deployment.update({
          where: { id: deployment.id },
          data: {
            status: 'FAILED',
            buildLogs,
            deployLogs,
          },
        });

        return {
          success: false,
          error: rolledBack ? 'New release failed to start; the previous one is back up' : 'Application failed to start',
          buildLogs,
          deployLogs,
          rolledBack,
        };
      }

      await prisma.deployment.update({
        where: { id: deployment.id },
        data: {
          status: 'SUCCESS',
          buildLogs,
          deployLogs,
        },
      });

      const port = application.port || this.getDefaultPort(application.type);

      const release = await prisma.release.create({
        data: {
          applicationId: application.id,
          commitSha: commitSha ?? null,
          status: 'READY',
          ports: { port },
          health: 'HEALTHY',
          logsRef: logsDir,
          path: buildResult.releaseDir ?? null,
          deploymentId: deployment.id,
        },
      });

      // the new release is live and recorded: whatever fell out of the rollback window goes
      await cleanupAppReleases(afs, application.id).catch(() => {});

      await prisma.application.update({
        where: { id: application.id },
        data: { activeReleaseId: release.id },
      });

      // The app is up; without its route the hostname is not. Said first in the
      // deploy log (the line the history shows), not swallowed. It stays RUNNING
      // on purpose: the watchdog re-applies routes of running apps, so a Caddy
      // that was briefly unreachable heals on its own; an ERROR app never would.
      let routeWarning = '';
      if (application.type !== 'PHP') {
        try {
          await configureCaddyForRuntimeApplication(
            await serverForApplication(application.id),
            application.domain,
            port,
          );
        } catch (error: any) {
          routeWarning =
            `The app is running, but its Caddy route could not be set — ${application.domain} is not served yet: ` +
            `${error?.message ?? String(error)}. The watchdog retries it; redeploy to try now.` + NL;
          console.error(`Caddy route for ${application.domain} not set:`, error?.message ?? error);
          await afs.appendFile(deployLogPath, routeWarning).catch(() => {});
          await prisma.deployment
            .update({ where: { id: deployment.id }, data: { deployLogs: routeWarning + deployLogs } })
            .catch(() => {});
        }
      }

      return {
        success: true,
        buildLogs,
        deployLogs: routeWarning + deployLogs,
      };

    } catch (error: any) {
      if (error instanceof CancelledError) {
        // what was built so far stays in the build log; the reason goes first
        await prisma.deployment.update({
          where: { id: deployment.id },
          data: { status: 'CANCELLED', deployLogs: 'Cancelled — the previous release, if any, keeps serving' },
        });
        return { success: false, cancelled: true, error: 'Deployment cancelled' };
      }

      await prisma.deployment.update({
        where: { id: deployment.id },
        data: {
          status: 'FAILED',
          buildLogs: error.message,
        },
      });

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get application status from its systemd unit
   */
  async getApplicationStatus(domain: string): Promise<'RUNNING' | 'STOPPED' | 'UNKNOWN' | 'ERROR'> {
    try {
      if (!domain) {
        return 'ERROR';
      }

      const application = await this.appWithOrg(domain);
      if (!application) return 'ERROR';
      return systemd.getStatus(application);
    } catch (error) {
      return 'ERROR';
    }
  }

  /**
   * Clear logs for a specific deployment
   */
  async clearDeploymentLogs(deploymentId: string): Promise<boolean> {
    try {
      if (!deploymentId) {
        return false;
      }

      const deployment = await prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { applicationId: true },
      });

      if (!deployment) {
        return false;
      }

      const afs = await appFsFor(deployment.applicationId);
      const logsDir = logsDirFor(afs.appDir);
      await afs.writeFile(join(logsDir, 'build.log'), '');
      await afs.writeFile(join(logsDir, 'deploy.log'), '');

      console.log(`Cleared logs for deployment: ${deploymentId}`);
      return true;
    } catch (error) {
      console.error('Error clearing deployment logs:', error);
      return false;
    }
  }

  /** Last `lines` lines of a log file, or a message saying why there are none. */
  private async tailLog(afs: AppFs, logFile: string, lines: number, logType: string): Promise<string> {
    try {
      if (!(await afs.exists(logFile))) {
        return `Log file not found: ${logFile}`;
      }
      // ponytail: whole file over SFTP, then sliced. `tail -n` on the node if logs get big.
      const content = await afs.readText(logFile);
      return content.split('\n').slice(-lines).join('\n');
    } catch (error) {
      return `No logs available for ${logType}: ${error}`;
    }
  }

  /**
   * Get deployment logs by deployment ID
   */
  async getDeploymentLogs(deploymentId: string, logType: string = 'build', lines: number = 100): Promise<string> {
    try {
      if (!deploymentId) {
        return 'No deployment ID provided';
      }

      const deployment = await prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { applicationId: true },
      });

      if (!deployment) {
        return 'Deployment not found';
      }

      const afs = await appFsFor(deployment.applicationId);
      const name = logType === 'build' ? 'build' : logType === 'deploy' ? 'deploy' : 'combined';
      return this.tailLog(afs, join(logsDirFor(afs.appDir), `${name}-${deploymentId}.log`), lines, logType);
    } catch (error) {
      return `No logs available for ${logType}: ${error}`;
    }
  }

  /**
   * Get application logs from files
   */
  async getApplicationLogsFromFiles(domain: string, logType: string = 'combined', lines: number = 100): Promise<string> {
    try {
      if (!domain) {
        return 'No domain provided';
      }

      const afs = await appFsForDomain(domain);
      if (!afs) return `No application found for domain ${domain}`;

      const logsDir = logsDirFor(afs.appDir);
      if (logType === 'combined') {
        // the unit writes stdout and stderr to separate files; show both, headed like `tail` does
        const [out, err] = await Promise.all(['out.log', 'error.log'].map((name) => this.tailLog(afs, join(logsDir, name), lines, logType)));
        return `==> out.log <==\n${out}\n\n==> error.log <==\n${err}`;
      }
      const name = ({ out: 'out.log', error: 'error.log', build: 'build.log' } as Record<string, string>)[logType] ?? 'out.log';
      return this.tailLog(afs, join(logsDir, name), lines, logType);
    } catch (error) {
      return `No logs available for ${logType}: ${error}`;
    }
  }

  /**
   * Check if build log exists for a domain
   */
  async checkBuildLogExists(domain: string): Promise<{ exists: boolean; path: string; size?: number }> {
    try {
      if (!domain) {
        return { exists: false, path: '' };
      }

      const afs = await appFsForDomain(domain);
      if (!afs) return { exists: false, path: '' };

      const buildLogPath = join(logsDirFor(afs.appDir), 'build.log');
      const size = await afs.size(buildLogPath);
      return size === null ? { exists: false, path: buildLogPath } : { exists: true, path: buildLogPath, size };
    } catch (error) {
      return {
        exists: false,
        path: ''
      };
    }
  }

  /**
   * Create a test build log entry for debugging
   */
  async createTestBuildLog(domain: string, message: string = 'Test build log entry'): Promise<boolean> {
    try {
      if (!domain) {
        return false;
      }

      const afs = await appFsForDomain(domain);
      if (!afs) return false;

      const logsDir = logsDirFor(afs.appDir);
      await afs.mkdir(logsDir);

      const buildLogPath = join(logsDir, 'build.log');
      await afs.appendFile(buildLogPath, `[${new Date().toISOString()}] TEST: ${message}` + NL);
      console.log(`Test build log entry created at: ${buildLogPath}`);
      return true;
    } catch (error) {
      console.error(`Failed to create test build log: ${error}`);
      return false;
    }
  }
}
