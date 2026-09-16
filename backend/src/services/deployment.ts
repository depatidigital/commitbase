import * as path from 'path';
import { Application, Deployment, Release } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { staticRouteError } from './caddyService';
import { serveApp, serveStatic } from './hostRouteService';
import { appBuild, ensureOrgOnNode, sourceTreeUnit } from './orgProvisionService';
import { serverForApplication, appsOnServer } from '../lib/servers';
import type { AppWithOrg } from './systemdService';
import { isPublishable, uploadSiteObject } from './r2Service';
import { adoptRootFiles, discardFolder, inFolder, pruneStaticReleases, releaseFolder, siteStorage } from './staticReleaseService';
import { releasesDirFor, currentDirFor, sharedDirFor, logsDirFor, inRootDirectory } from '../lib/appPaths';
import { appFsFor, sourceFsFor, type AppFs } from '../lib/appFs';
import { detectProject, nvmPreamble, EXEC, pnpmAllowBuildsInFolder, type DetectedProject } from '../lib/projectDetect';

// world-readable in /tmp: flock takes an exclusive lock on a read-only fd, whichever build user made it
const NPM_LOCK = '/tmp/larika-npm.lock';
const LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'package-lock.json', 'bun.lockb'];
import { gitAuthFor } from '../lib/gitCredentials';
import { readEnv, sealEnv } from '../lib/appEnv';
import { forwardTcp } from '../lib/runner';
import * as systemd from './systemdService';
import * as http from 'http';
import { cleanupAppReleases } from './appDiskService';
import { buildKeyOf, groupBuildKey } from '../lib/buildKey';
import { restoreSnapshot, snapshotDatabase, type Snapshot } from './databaseSnapshotService';
import { resetDatabase } from './databaseProvisionService';

// Ports handed to runtime apps. Every app gets one for life; Caddy proxies to
// it on localhost. Apps must listen on $PORT — the health check enforces it.
const PORT_POOL_START = Number(process.env.APP_PORT_POOL_START || 20000);
const PORT_POOL_END = Number(process.env.APP_PORT_POOL_END || 29999);
const HEALTH_TIMEOUT_MS = Number(process.env.APP_HEALTH_TIMEOUT_MS || 60000);
// Builds are the memory hogs (next build ≈ 1-2 GB). One at a time by default.
const BUILD_CONCURRENCY = Math.max(1, Number(process.env.BUILD_CONCURRENCY || 1));

// ponytail: in-process locks. Fine for one backend; a DB row lock if the backend ever runs twice.
const deploying = new Set<string>();
// a pull in flight per checkout — a project's apps share one
const syncing = new Map<string, Promise<string>>();
// deploys a user asked to stop; checked between steps (cancelDeploy)
const cancelling = new Set<string>();

/** A deploy stopped on request — recorded as CANCELLED, not FAILED. */
class CancelledError extends Error {}
/** What the locks are held on: the app — each deploys on its own, in its own tree. */
const lockKey = (application: { id: string }) => application.id;
const throwIfCancelled = (key: string) => {
  if (cancelling.has(key)) throw new CancelledError('Deployment cancelled');
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

/** Single-quote for bash. */
const q = (v: string) => `'${String(v).replace(/'/g, `'\\''`)}'`;

/**
 * One app's part of build.sh: install where the lockfile is, then its steps in
 * its folder — in a subshell, so its env, Node and cwd end with it and the next
 * app's build never sees them. A failing step fails the script (set -e holds
 * inside the subshell, and its exit status fails the outer script). Pure.
 */
export function buildBlock(opts: {
  heading: string | null;
  nodeVersion: string | null;
  env: Record<string, string>;
  installDir: string;
  installs: string[];
  workDir: string;
  steps: string[];
}): string[] {
  const run = (step: string) => ['  echo', `  echo ${q('$ ' + step)}`, `  ${step}`];
  return [
    ...(opts.heading ? ['', `echo ${q(`==> ${opts.heading}`)}`] : []),
    '(',
    ...nvmPreamble(opts.nodeVersion, true).map((line) => '  ' + line),
    '  echo "node $(node -v 2>/dev/null || echo missing) at $(command -v node || true)"',
    ...Object.entries(opts.env)
      .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
      .map(([k, v]) => `  export ${k}=${q(v)}`),
    ...(opts.installs.length > 0 ? [`  cd ${q(opts.installDir)}`, ...opts.installs.flatMap(run)] : []),
    `  cd ${q(opts.workDir)}`,
    ...opts.steps.flatMap(run),
    ')',
  ];
}

/** build.sh from the apps' blocks. NODE_ENV stays unset: production would skip devDependencies. */
export const buildScript = (blocks: string[][]): string =>
  ['#!/bin/bash', '# Generated by Larika for one deploy. Overwritten on the next.', 'set -euo pipefail', 'unset NODE_ENV', ...blocks.flat(), ''].join(NL);

/** Every publishable file under `dir` (on whichever side `afs` is) into the site bucket. */
async function uploadSiteTree(bucket: string, afs: AppFs, dir: string): Promise<number> {
  let count = 0;
  const walk = async (current: string): Promise<void> => {
    for (const name of await afs.readdir(current)) {
      const full = join(current, name);
      if (await afs.isDirectory(full)) {
        if (isPublishable(name)) await walk(full); // never descend into .git / node_modules
      } else if (await uploadSiteObject(bucket, path.posix.relative(dir, full), await afs.readFile(full))) {
        count += 1;
      }
    }
  };
  await walk(dir);
  return count;
}

/** Git in the sources tree. safe.directory: after the first deploy the tree belongs to the tenant user. */
const gitIn = (afs: AppFs, sourcesDir: string, args: string[], env?: Record<string, string>) =>
  afs.run(['git', '-c', `safe.directory=${sourcesDir}`, ...args], { cwd: sourcesDir, timeout: 600_000, ...(env && { env }) });

export interface DeploymentConfig {
  application: Application;
  deployment: Deployment;
  envVars?: Record<string, string>;
  /** a Prisma migration recorded as failed (P3009), cleared before the migrations run — runBuild */
  resolveMigration?: string;
  /** how: rolled back (the default — it runs again) or applied (a baseline: its tables already exist) */
  resolveAs?: 'rolled-back' | 'applied';
  /** the app's databases emptied before the build — after their snapshot, which is the way back */
  resetDatabase?: boolean;
  /** the pre-deploy step (the migrations) left out this once — the code goes live on the schema as it is */
  skipPreDeploy?: boolean;
}

export interface BuildResult {
  success: boolean;
  error?: string;
  releaseDir?: string;
  /** PHP: each app's document root, relative to the release */
  docroots?: Record<string, string>;
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
  private async appWithOrg(id: string) {
    return prisma.application.findUnique({
      where: { id },
      include: { organization: { select: { slug: true } } },
    });
  }

  /** Create the application's source tree (logs/, sources/) where it belongs. */
  async prepareAppDirectory(applicationId: string): Promise<AppFs> {
    const afs = await sourceFsFor(applicationId);
    try {
      await afs.mkdir(logsDirFor(afs.appDir));
      await afs.mkdir(afs.sourcesDir);
      return afs;
    } catch (error: any) {
      throw new Error(`Failed to prepare app directory: ${error?.stderr || error?.message || error}`);
    }
  }

  /**
   * Clone or pull the repository into the checkout. One project's apps share it,
   * so two of them deploying at once pull one after the other, never together.
   */
  async syncRepository(
    afs: AppFs,
    repository: string,
    branch: string = 'main',
    gitAccountId: string | null = null
  ): Promise<string> {
    const sourcesDir = afs.sourcesDir;
    const previous = syncing.get(sourcesDir) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.syncRepositoryNow(afs, repository, branch, gitAccountId));
    syncing.set(sourcesDir, run);
    try {
      return await run;
    } finally {
      if (syncing.get(sourcesDir) === run) syncing.delete(sourcesDir);
    }
  }

  private async syncRepositoryNow(afs: AppFs, repository: string, branch: string, gitAccountId: string | null): Promise<string> {
    const sourcesDir = afs.sourcesDir;
    try {
      // Private repositories need the connected account's token. It reaches git
      // as an environment variable read back by a one-shot credential helper,
      // so it never lands in .git/config, in `ps`, or in this log.
      const auth = await gitAuthFor(gitAccountId);

      if (await afs.exists(join(sourcesDir, '.git'))) {
        console.log(`Pulling latest changes for ${repository} on branch ${branch}`);
        // --depth=1: the checkout is built from, never browsed — no history on disk
        await gitIn(afs, sourcesDir, [...auth.args, 'fetch', '--depth=1', 'origin'], auth.env);
        await gitIn(afs, sourcesDir, ['reset', '--hard', `origin/${branch}`]);
      } else {
        console.log(`Cloning repository ${repository} on branch ${branch}`);
        // shallow, every branch: the tree at HEAD is all a build needs, and a later
        // branch switch (fetch origin/<other>) must still find the other branches
        await afs.run(['git', ...auth.args, 'clone', '--depth=1', '--no-single-branch', '-b', branch, '--', repository, sourcesDir], {
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

  /** A kept build with this key whose tree is still on disk, newest first — or null. */
  private async reusableRelease(afs: AppFs, applicationId: string, buildKey: string): Promise<Release | null> {
    // an optimisation: whatever goes wrong looking (a schema not migrated yet,
    // an unreachable node) means build as usual, never a failed deploy
    try {
      const release = await prisma.release.findFirst({
        where: { applicationId, buildKey, status: 'READY', path: { not: null } },
        orderBy: { createdAt: 'desc' },
      });
      return release && (await afs.isDirectory(release.path!)) ? release : null;
    } catch (error: any) {
      console.error(`Build cache lookup for ${applicationId} failed, building instead:`, error?.message ?? error);
      return null;
    }
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
   *
   * `afs` is the app's tree; `group` is the app (a list from when a source's apps
   * built together — each is detected and built in its own folder with its own env).
   */
  async runBuild(
    afs: AppFs,
    group: AppWithOrg[],
    deployment: Deployment,
    envs: Map<string, Record<string, string>>,
    /** a failed Prisma migration to mark rolled back (or applied) before the pre-deploy step */
    resolveMigration?: string,
    resolveAs: 'rolled-back' | 'applied' = 'rolled-back',
    skipPreDeploy = false,
  ): Promise<BuildResult> {
    const { appDir, sourcesDir } = afs;
    const first = group[0]!;
    const logsDir = logsDirFor(appDir);
    await afs.mkdir(logsDir);
    const buildLogPath = join(logsDir, 'build.log');
    const log = (line: string) => afs.appendFile(buildLogPath, line + NL);
    // the release this build is making — removed again if it fails
    let madeRelease: string | null = null;
    // log lines say which app when there are several
    const named = (app: Application) => (group.length > 1 ? `${app.name}${app.rootDirectory ? ` (${app.rootDirectory})` : ''}: ` : '');

    try {
      for (const app of group) if (systemd.needsUnit(app.type)) await this.allocatePort(app, afs);
      await this.removeOrphanReleases(afs, first.id);

      // appended: the deploy emptied build.log when it began — one log for the whole deploy
      await afs.appendFile(buildLogPath, `[${new Date().toISOString()}] BUILD STARTED` + NL);

      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
      const releaseDir = join(releasesDirFor(appDir), stamp);
      await afs.mkdir(releaseDir);
      madeRelease = releaseDir;
      // ponytail: full copy per release, tar excludes the junk. Hardlink node_modules from the previous release if installs get slow.
      // node_modules unanchored: a monorepo's packages each have their own
      await afs.run(
        ['sh', '-c', 'tar -C "$1" --exclude=node_modules --exclude=./.next --exclude=./.git -cf - . | tar -C "$2" -xf -', 'sh', sourcesDir, releaseDir],
        { timeout: 300_000 },
      );

      const docroots: Record<string, string> = {};
      const installed = new Set<string>();
      // one block of build.sh per app, in a subshell: its env and Node stay its own
      const blocks: string[][] = [];

      for (const app of group) {
        const envVars = envs.get(app.id) ?? {};
        const workDir = inRootDirectory(releaseDir, app.rootDirectory);
        if (!(await afs.isDirectory(workDir))) throw new Error(`There is no folder ${app.rootDirectory} in the repository (${app.name})`);

        const detected = await detectProject(workDir, afs.readText, undefined, releaseDir, app.packageManager);
        // a workspace installs at the root; composer.lock is always the folder's own
        const installDir = detected.installAtRoot && detected.type !== 'PHP' ? releaseDir : workDir;
        await log(`${named(app)}Detected: ${detected.label} (${detected.packageManager})${installDir !== workDir ? ', installing at the repository root' : ''}`);
        docroots[app.id] = join(app.rootDirectory ?? '', detected.outputDir || '.');

        if (detected.framework === 'nextjs') {
          // Next's build cache survives across releases — big win on rebuilds.
          // ponytail: a monorepo app's is shared/next-cache-<app id>; the disk card only counts next-cache.
          const cache = join(sharedDirFor(appDir), app.rootDirectory ? `next-cache-${app.id}` : 'next-cache');
          await afs.mkdir(cache);
          await afs.mkdir(join(workDir, '.next'));
          await afs.symlink(cache, join(workDir, '.next', 'cache'));
        }

        const has = (f: string) => afs.exists(join(workDir, f));
        // a path of the app's folder, relative to the release
        const inFolder = (f: string) => join(app.rootDirectory ?? '', f);
        const installs: string[] = [];
        const steps: string[] = [];

        // the app's own install command when set, else the detected one
        const installCommand = app.installCommand || detected.installCommand;
        // once per folder and command: a workspace's apps share one install
        const firstInstall = (command: string) => {
          const key = `${installDir}\n${command}`;
          if (installed.has(key)) return false;
          installed.add(key);
          return true;
        };

        if (detected.type === 'PHP') {
          if (installCommand && firstInstall(installCommand)) {
            if (await this.reuseInstalled(afs, releaseDir, inFolder('composer.lock'), inFolder('vendor'))) {
              await log(`${named(app)}vendor: composer.lock unchanged, hardlinked from the previous release`);
            } else {
              installs.push(installCommand);
            }
          }
          // Laravel and friends read .env from the app root. The platform's env
          // vars win over whatever the repository shipped.
          if (detected.framework === 'laravel' && !envVars.APP_KEY) {
            // Laravel refuses to boot without one. Generate once and keep it on
            // the app so sessions survive the next deploy.
            envVars.APP_KEY = 'base64:' + require('crypto').randomBytes(32).toString('base64');
            await prisma.application.update({ where: { id: app.id }, data: { envVars: sealEnv(envVars) } });
            await log(`${named(app)}Generated APP_KEY and saved it to the app env`);
          }
          const entries = Object.entries(envVars).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
          if (entries.length > 0) {
            const shipped = await afs.readText(join(workDir, '.env')).catch(() => '');
            const kept = shipped.split(/\r?\n/).filter((line) => !entries.some(([k]) => line.startsWith(k + '=')));
            const own = entries.map(([k, v]) => `${k}="${String(v).replace(/(["\\$])/g, '\\$1')}"`);
            await afs.writeFile(join(workDir, '.env'), [...kept, ...own].join(NL) + NL);
          }
        } else if (await has('package.json')) {
          // The env is exported to the build, but some tools read the file
          // itself: Prisma 7's prisma.config.ts loads '.env' and fails on
          // ENOENT without it, and so does anything calling loadEnvFile().
          // The platform's values win over a .env the repository shipped.
          const envEntries = Object.entries(envVars).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
          if (envEntries.length > 0) {
            const shipped = await afs.readText(join(workDir, '.env')).catch(() => '');
            const kept = shipped.split(/\r?\n/).filter((line) => line.trim() && !envEntries.some(([k]) => line.startsWith(k + '=')));
            // as readable as build.sh, which already carries the same values
            await afs.writeFile(join(workDir, '.env'), [...kept, ...envEntries.map(([k, v]) => dotenvLine(k, String(v)))].join(NL) + NL, { mode: 0o660 });
          }

          if (firstInstall(installCommand)) {
            // the lockfile the repo has — a chosen pnpm may still be installing from package-lock.json
            const present = new Set<string>();
            for (const f of LOCKFILES) if (await has(f)) present.add(f);
            const lock = LOCKFILES.find((f) => present.has(f));
            // ponytail: node_modules is reused only for a folder with its own
            // lockfile — a workspace install also fills every package's node_modules.
            const reusable = installDir === workDir;
            if (reusable && lock && (await this.reuseInstalled(afs, releaseDir, inFolder(lock), inFolder('node_modules')))) {
              await log(`${named(app)}node_modules: lockfile unchanged, hardlinked from the previous release`);
            } else {
              // npm installs on one machine take turns: two writing ~/.npm at once left tarballs
              // "corrupted". pnpm's store is safe under concurrency, so it is not held up.
              // ponytail: one lock per machine; the cache is shared and stays one copy.
              // pnpm 10.9+ runs dependencies' build scripts (prisma engines, esbuild) only when allowed, and
              // errors otherwise (ERR_PNPM_IGNORED_BUILDS): said in the workspace file it reads in every version
              if (detected.packageManager === 'pnpm') {
                installs.push(
                  `grep -qs dangerouslyAllowAllBuilds pnpm-workspace.yaml || printf '\ndangerouslyAllowAllBuilds: true\n' >> pnpm-workspace.yaml`,
                );
              }
              installs.push(
                detected.packageManager === 'npm'
                  ? // made 0666 by whichever build user is first, so the others can open it too
                    `( umask 000; : >> ${NPM_LOCK} ) 2>/dev/null || true; flock -w 1800 ${NPM_LOCK} sh -c ${q(installCommand)}`
                  : installCommand,
              );
            }
          }
        }
        if (await has('requirements.txt')) steps.push('python3 -m pip install --user -r requirements.txt');
        // every build, even with node_modules reused: the client lands in the release tree
        if (detected.generateCommand) steps.push(detected.generateCommand);
        // Migrations and the like: before the build, which may query the tables
        // (Next prerendering), in the same script and env. A failure leaves the
        // old release live — but a migration that ran and a build that then
        // failed leave the old release on the new schema.
        // a migration Prisma recorded as failed (P3009) blocks every one after it: asked
        // for from the history, its record is cleared right before the migrations run again
        if (resolveMigration && !skipPreDeploy) steps.push(`${EXEC[detected.packageManager]} prisma migrate resolve --${resolveAs} ${resolveMigration}`);
        if (app.preDeployCommand && !skipPreDeploy) steps.push(app.preDeployCommand);
        if (app.preDeployCommand && skipPreDeploy) steps.push(`echo 'pre-deploy step skipped this once: ${app.preDeployCommand.replace(/'/g, "'\\''")}'`);
        const buildCommand = app.buildCommand || detected.buildCommand;
        if (buildCommand) steps.push(buildCommand);

        if (installs.length === 0 && steps.length === 0) continue;

        // NEXT_PUBLIC_* and friends are baked in at build time, so the app's
        // env is exported here. NODE_ENV stays unset: production would skip
        // the devDependencies most build tools live in.
        // CI=1: no prompt can ever wait for an answer. pnpm 10 blocks
        // dependencies' build scripts (prisma engines, esbuild, sharp) until
        // `pnpm approve-builds` is answered — interactively — and in CI just
        // skips them, so the app breaks later instead. The build is already
        // the app's own code in its build cgroup as the build user; its
        // dependencies' scripts are no less trusted than that.
        blocks.push(
          buildBlock({
            heading: group.length > 1 ? `${app.name}${app.rootDirectory ? ` (${app.rootDirectory})` : ''}` : null,
            nodeVersion: detected.nodeVersion,
            env: {
              ...envVars,
              PORT: String(app.port || ''),
              CI: '1',
              NEXT_TELEMETRY_DISABLED: '1',
              // pnpm's own prefix (11+); pnpm 10 gets the same from pnpm-workspace.yaml (the install step).
              // Not npm_config_*: that reaches npx in the app's own commands, and npm warns about each.
              // package_manager_strict: pnpm chosen over a package.json that names npm
              ...(detected.packageManager === 'pnpm' && {
                pnpm_config_dangerously_allow_all_builds: 'true',
                pnpm_config_package_manager_strict: 'false',
              }),
            },
            installDir,
            installs,
            workDir,
            steps,
          }),
        );
      }

      if (blocks.length > 0) {
        // One script for the whole build, so it can run under systemd-run in its own cgroup.
        const scriptPath = join(appDir, 'build.sh');
        await afs.rm(scriptPath, { force: true }); // may be owned by the tenant after chown
        await afs.writeFile(scriptPath, buildScript(blocks), { mode: 0o660 });

        const slug = first.organization?.slug;
        // there is no building on the panel: appFsFor only hands out a node for tenant apps
        if (!afs.node || !slug || !first.sourceId) throw new Error('This app has no organization node to build on');
        {
          // On the node, in the build cgroup, as the unprivileged build user.
          // Output is appended to build.log as it prints — serially, so chunks
          // land in order — which is what the live log view follows.
          let appending: Promise<unknown> = Promise.resolve();
          const onOutput = (text: string) => {
            appending = appending.then(() => afs.appendFile(buildLogPath, text)).catch(() => {});
          };
          try {
            await appBuild(slug, first.id, onOutput, blocks.length);
          } finally {
            await appending;
          }
        }
      }

      await log(NL + `[${new Date().toISOString()}] BUILD COMPLETED`);
      return { success: true, releaseDir, docroots };
    } catch (error: any) {
      const message = error.stderr || error.message || String(error);
      await log(NL + `[${new Date().toISOString()}] BUILD FAILED:` + NL + message).catch(() => {});
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
    // It does fail once the live release belongs to the tenant: with
    // fs.protected_hardlinks=1 the deploy user may not link another user's
    // files. Linking as root would get past that; a fresh install is fine.
    const target = join(releaseDir, dir);
    return afs
      .run(['cp', '-al', '--', prevDir, target], { timeout: 300_000 })
      .then(() => true)
      .catch(async () => {
        // a half-copied tree must not stay: pnpm finds its .modules.yaml, says
        // "Already up to date" and installs nothing — packages go missing
        await afs.rm(target, { recursive: true, force: true }).catch(() => {});
        return false;
      });
  }

  /**
   * PHP apps have no unit: the org's PHP-FPM pool serves them. Publishing is
   * handing the tree to the tenant user and pointing Caddy at the docroot.
   * `afs` is the app's source tree; `docroot` is relative to its releases.
   */
  private async publishPhp(application: AppWithOrg, afs: AppFs, docroot: string): Promise<boolean> {
    const slug = application.organization?.slug;
    if (!slug) throw new Error('PHP apps need an organization (the FPM pool is per org)');

    const deployLogPath = join(logsDirFor(afs.appDir), 'deploy.log');
    await sourceTreeUnit('chown', slug, application.sourceId ?? application.id, application.id);

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

    await serveApp(node, application.id, { kind: 'php', root, socket });
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
      select: { domains: { select: { host: true } } },
    });
    return apps.flatMap((app) => app.domains.map((d) => d.host));
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
        if (await this.applyCaddyRoute(app)) applied += 1;
      } catch (error: any) {
        failed += 1;
        console.error(`Caddy route for ${app.name} not re-applied: ${error?.message || error}`);
      }
    }
    return { applied, failed };
  }

  /** Route one app's hostname to what it serves. False when it has nothing to route yet. */
  async applyCaddyRoute(app: AppWithOrg): Promise<boolean> {
    const node = await serverForApplication(app.id);
    if (app.type === 'STATIC') {
      await serveStatic(node, app.id, app.staticOrigin);
    } else if (app.type === 'PHP') {
      const afs = await sourceFsFor(app.id);
      const current = currentDirFor(afs.appDir);
      const detected = await detectProject(inRootDirectory(current, app.rootDirectory), afs.readText, undefined, current, app.packageManager);
      if (!(await this.publishPhp(app, afs, join(app.rootDirectory ?? '', detected.outputDir || '.')))) throw new Error('no FPM socket');
    } else if (app.port) {
      await serveApp(node, app.id, { kind: 'proxy', port: app.port });
    } else {
      return false;
    }
    return true;
  }

  /**
   * (Re)install and start the unit for an application.
   */
  async startApplication(applicationId: string): Promise<boolean> {
    let afs: AppFs | null = null;
    const deployLog = (line: string) =>
      afs ? afs.appendFile(join(logsDirFor(afs.appDir), 'deploy.log'), line + NL).catch(() => {}) : Promise.resolve();

    try {
      const application = await this.appWithOrg(applicationId);
      if (!application) {
        throw new Error('Application not found');
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
   * Activate a release. The tree already on disk is the release, so this is a
   * unit reinstall and restart. True when it came up.
   */
  async startRelease(application: Application, release: Release): Promise<boolean> {
    const afs = await sourceFsFor(application.id);
    await afs.mkdir(logsDirFor(afs.appDir));
    await afs.appendFile(join(logsDirFor(afs.appDir), 'deploy.log'), `[${new Date().toISOString()}] RELEASE STARTED: ${release.id}` + NL);

    if (release.path) {
      if (!(await afs.isDirectory(release.path))) throw new Error(`Release directory is gone: ${release.path}`);
      await this.activateRelease(afs, release.path);
    }

    // PHP serves straight from `current`: the switch above is all it needs
    return systemd.needsUnit(application.type) ? this.startApplication(application.id) : true;
  }

  /** The app with its organization's slug — what the build and the unit need. */
  async groupOf(application: Application): Promise<AppWithOrg[]> {
    return [await prisma.application.findUniqueOrThrow({ where: { id: application.id }, include: { organization: { select: { slug: true } } } })];
  }

  async stopApplication(applicationId: string): Promise<boolean> {
    try {
      const application = await this.appWithOrg(applicationId);
      if (!application) return false;
      await systemd.stopApplication(application);
      return true;
    } catch (error) {
      console.error('Failed to stop application:', error);
      return false;
    }
  }

  async restartApplication(applicationId: string): Promise<boolean> {
    try {
      const application = await this.appWithOrg(applicationId);
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
  async getApplicationLogs(applicationId: string, lines: number = 100): Promise<string> {
    return this.getApplicationLogsFromFiles(applicationId, 'out', lines);
  }

  /** True while a deploy of this application is in flight. */
  isDeploying(application: { id: string }): boolean {
    return deploying.has(lockKey(application));
  }

  /**
   * Full deployment process. One deploy per app at a time, and at most
   * BUILD_CONCURRENCY builds on the box.
   */
  async deploy(config: DeploymentConfig): Promise<DeployResult> {
    const id = lockKey(config.application);
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
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      select: { id: true, type: true, organization: { select: { slug: true } } },
    });
    if (!app) return false;
    const key = lockKey(app);
    if (!deploying.has(key)) {
      // nothing runs here, but the rows may still say so — a launch that died
      // before it got this far, or a crash — and Cancel is how they get unstuck
      const stuck = await prisma.deployment.updateMany({
        where: { applicationId, status: { in: ['PENDING', 'BUILDING', 'DEPLOYING'] } },
        data: { status: 'CANCELLED', deployLogs: 'Cancelled — nothing was running for it; the previous release, if any, keeps serving' },
      });
      const live = await prisma.application.findUnique({ where: { id: applicationId }, select: { activeReleaseId: true } });
      const status = await prisma.application.updateMany({
        where: { id: applicationId, status: { in: ['DEPLOYING', 'BUILDING'] } },
        data: { status: live?.activeReleaseId ? 'RUNNING' : 'STOPPED' },
      });
      return stuck.count > 0 || status.count > 0;
    }
    cancelling.add(key);
    if (app.organization?.slug) {
      // the build runs as the app's: cb-build-<slug>-<app id>
      await sourceTreeUnit('cancel-build', app.organization.slug, key, applicationId).catch((error: any) =>
        console.error(`Could not stop the build of ${applicationId}:`, error?.message ?? error),
      );
    }
    return true;
  }

  /**
   * Build a static site from the checkout in `afs` (its tree on the panel) and
   * upload the output to a fresh release folder in its R2 location. Nothing
   * serves the folder yet: the serving one is untouched until the route moves
   * (services/staticReleaseService.ts).
   */
  private async buildStaticRelease(
    application: AppWithOrg,
    afs: AppFs,
    deploymentId: string,
    envVars: Record<string, string>,
    buildLogPath: string,
  ): Promise<{ bucket: string; origin: string; folder: string }> {
    const sourcesDir = afs.sourcesDir;
    await afs.appendFile(buildLogPath, `[${new Date().toISOString()}] STATIC BUILD STARTED` + NL);

    // Same detection the create screen showed: install before building,
    // take the framework's output folder, and let a plain HTML repo
    // (no package.json, no build) ship as-is.
    // A monorepo site is detected and built in its folder; a workspace
    // installs at the repository root.
    const workDir = inRootDirectory(sourcesDir, application.rootDirectory);
    if (!(await afs.isDirectory(workDir))) throw new Error(`There is no folder ${application.rootDirectory} in the repository`);
    const detected = await detectProject(workDir, afs.readText, undefined, sourcesDir, application.packageManager);
    const hasPackageJson = await afs.exists(join(workDir, 'package.json'));
    const install = hasPackageJson ? detected.installCommand : '';
    const build = application.buildCommand || detected.buildCommand || '';

    await afs.appendFile(buildLogPath, `Detected: ${detected.label}` + NL);

    // What the build leaves in the checkout goes once the output is in R2, built or
    // not: node_modules (npm ci wipes and reinstalls it every time anyway — the npm
    // cache keeps that fast) and the output folder. The checkout stays as cloned,
    // so two sites of one project never trip over each other's install.
    const leftovers = [join(workDir, 'node_modules'), ...(detected.installAtRoot ? [join(sourcesDir, 'node_modules')] : [])];
    const sweep = () => Promise.all(leftovers.map((p) => afs.rm(p, { recursive: true, force: true }).catch(() => {})));
    try {
      return await this.buildAndUploadStatic(application, afs, deploymentId, envVars, buildLogPath, sourcesDir, workDir, detected, install, build, leftovers);
    } finally {
      await sweep();
    }
  }

  private async buildAndUploadStatic(
    application: AppWithOrg,
    afs: AppFs,
    deploymentId: string,
    envVars: Record<string, string>,
    buildLogPath: string,
    sourcesDir: string,
    workDir: string,
    detected: DetectedProject,
    install: string,
    build: string,
    leftovers: string[],
  ): Promise<{ bucket: string; origin: string; folder: string }> {
    const steps = [install, build].filter(Boolean);
    // pnpm 11+ takes the build permission from pnpm-workspace.yaml in the
    // install folder: the install flag alone leaves it failing with
    // ERR_PNPM_IGNORED_BUILDS (esbuild, sharp), as the node builds do too
    const allow = install && detected.packageManager === 'pnpm' ? [pnpmAllowBuildsInFolder()] : [];
    const installDir = detected.installAtRoot ? sourcesDir : workDir;
    if (steps.length === 0) {
      await afs.appendFile(buildLogPath, 'No build step — publishing the repository as-is' + NL);
    } else {
      // On the org's node: same build.sh and build cgroup (memory-capped, low
      // CPU/IO weight) as a Node app, so a runaway build hurts nobody else.
      // NODE_ENV stays unset: production would skip the devDependencies vite lives in.
      const slug = application.organization?.slug;
      if (!slug || !afs.node) throw new Error('This site has no organization node to build on');
      const scriptPath = join(afs.appDir, 'build.sh');
      await afs.rm(scriptPath, { force: true }); // may be owned by the tenant after chown
      await afs.writeFile(
        scriptPath,
        buildScript([
          buildBlock({
            heading: null,
            nodeVersion: detected.nodeVersion,
            env: {
              ...envVars,
              CI: '1',
              NEXT_TELEMETRY_DISABLED: '1',
              ...(detected.packageManager === 'pnpm' && {
                pnpm_config_dangerously_allow_all_builds: 'true',
                pnpm_config_package_manager_strict: 'false',
              }),
            },
            installDir,
            installs: [...allow, install].filter(Boolean),
            workDir,
            steps: [build].filter(Boolean),
          }),
        ]),
        { mode: 0o660 },
      );
      // output appended to build.log as it prints — serially, so chunks land in order
      let appending: Promise<unknown> = Promise.resolve();
      const onOutput = (text: string) => {
        appending = appending.then(() => afs.appendFile(buildLogPath, text)).catch(() => {});
      };
      try {
        await appBuild(slug, application.id, onOutput);
      } finally {
        await appending;
        // the build user owns what it wrote; hand the tree back so the sweep (and the next deploy) can touch it
        await sourceTreeUnit('chown', slug, application.sourceId ?? application.id, application.id).catch(() => {});
      }
      await afs.appendFile(buildLogPath, NL + `[${new Date().toISOString()}] STATIC BUILD COMPLETED` + NL);
    }

    const distCandidates = [detected.outputDir, 'dist', 'build', 'out'].filter((candidate): candidate is string => Boolean(candidate));
    let distDir: string | null = null;
    for (const candidate of distCandidates) {
      const candidatePath = join(workDir, candidate);
      if (await afs.exists(candidatePath)) {
        distDir = candidatePath;
        break;
      }
    }
    if (!distDir) {
      throw new Error(`Static build directory not found (looked for ${distCandidates.join(', ')})`);
    }
    // a build's output is a leftover too — not a repo published as-is, whose "output" is its files
    if (steps.length > 0 && distDir !== workDir) leftovers.push(distDir);

    const { bucket, origin } = await siteStorage(application as any);
    // a release row for files from before releases, so there is something to roll back to
    await adoptRootFiles(application as any);
    const folder = releaseFolder(deploymentId);
    try {
      await uploadSiteTree(inFolder(bucket, folder), afs, distDir);
    } catch (error) {
      await discardFolder(bucket, folder);
      throw error;
    }
    return { bucket, origin, folder };
  }

  private async deployInner(config: DeploymentConfig): Promise<DeployResult> {
    const { application, deployment, envVars = {} } = config;
    const key = lockKey(application);
    let commitSha: string | undefined;
    // the deploy's build log so far, for a failure thrown past every step's own handling
    let readBuildLog: (() => Promise<string>) | null = null;
    // the app's databases put back as they were before the migrations — a failed
    // deploy of an app nothing was live for (databaseSnapshotService); else a no-op
    let undoMigrations: (() => Promise<void>) | null = null;

    try {
      console.log(`Starting deployment for application: ${application.name}`);

      await prisma.deployment.update({
        where: { id: deployment.id },
        data: { status: 'BUILDING' },
      });

      // the app, with what the build needs (its org's slug) — `group` from when a source's apps built together
      const group = await this.groupOf(application);

      // The org has to exist on this app's node before anything lands there —
      // provisioned lazily, on the nodes it actually uses. A no-op once done.
      if (application.organizationId) {
        const node = await serverForApplication(application.id);
        await ensureOrgOnNode(application.organizationId, node.id, { userId: deployment.userId, trigger: 'deploy' });
      }
      throwIfCancelled(key);

      const afs = await this.prepareAppDirectory(application.id);
      const { appDir, sourcesDir } = afs;

      const logsDir = logsDirFor(appDir);
      const buildLogPath = join(logsDir, 'build.log');
      const deployLogPath = join(logsDir, 'deploy.log');
      const readLog = (file: string, missing: string) =>
        afs.readText(file).then((text) => (text.trim() ? text : missing), () => missing);
      readBuildLog = () => afs.readText(buildLogPath);

      // Fresh logs for a fresh deployment — each app's start log too, where it has its own
      await afs.writeFile(buildLogPath, '');
      await afs.writeFile(deployLogPath, '');
      const ownDeployLogs = new Map<string, { afs: AppFs; path: string }>();
      for (const app of group) {
        const own = await appFsFor(app.id);
        if (own.appDir === appDir) continue;
        const file = join(logsDirFor(own.appDir), 'deploy.log');
        await own.mkdir(logsDirFor(own.appDir));
        await own.writeFile(file, '');
        ownDeployLogs.set(app.id, { afs: own, path: file });
      }

      const source = application.sourceId ? await prisma.source.findUnique({ where: { id: application.sourceId } }) : null;
      if (source?.repository) {
        const branch = source.branch || 'main';
        await this.syncRepository(afs, source.repository, branch, source.gitAccountId);
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
      throwIfCancelled(key);

      if (application.type === 'STATIC') {
        // Static sites build on the panel (AppFs is local for them) and are
        // served from R2, so nothing here touches a node except the route.
        // Uploaded static sites already live in object storage — a redeploy has
        // nothing to build, so keep the deployment green instead of running a
        // build command against an empty sources tree.
        const prebuilt = !source?.repository && !application.buildCommand;

        if (prebuilt) {
          await afs.appendFile(buildLogPath, `[${new Date().toISOString()}] UPLOADED SOURCES — no build step` + NL);
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
            await serveStatic(await serverForApplication(application.id), application.id, (application as any).staticOrigin);
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

        try {
          const previousOrigin: string | null = (application as any).staticOrigin ?? null;
          // group[0]: the app with its org's slug — `application` came from the route without it
          const { bucket, origin, folder } = await this.buildStaticRelease(group[0]!, afs, deployment.id, envVars, buildLogPath);

          const release = await prisma.release.create({
            data: { applicationId: application.id, sourceId: application.sourceId, status: 'READY', path: folder, commitSha: commitSha ?? null, deploymentId: deployment.id },
          });
          const pointer = { staticBucket: bucket, staticOrigin: inFolder(origin, folder), activeReleaseId: release.id };
          const buildLogs = await readLog(buildLogPath, 'Build logs not available');

          try {
            await serveStatic(await serverForApplication(application.id), application.id, pointer.staticOrigin);
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

      // Migrations only go forward. Before the pre-deploy step runs them, the
      // app's databases as they are — the way back when the deploy fails: put
      // back on its own while nothing of the app is live yet (nothing else wrote
      // meanwhile); once it is, offered on the history row instead — the live
      // release kept writing during the build, and that is a person's call.
      const wasLive = !!application.activeReleaseId || application.status === 'RUNNING';
      const snapshots: Snapshot[] = [];
      if ((application.preDeployCommand && !config.skipPreDeploy) || config.resetDatabase) {
        const databases = await prisma.database.findMany({
          where: { applicationId: application.id, discovered: false, status: 'RUNNING' },
          select: { id: true, dbName: true },
        });
        for (const db of databases) {
          try {
            const snapshot = await snapshotDatabase(db.id, deployment.id);
            snapshots.push(snapshot);
            await afs.appendFile(
              buildLogPath,
              `[${new Date().toISOString()}] DATABASE SNAPSHOT: ${db.dbName} (${Math.round(snapshot.bytes / 1024)} KB) — ` +
                (wasLive ? 'restorable from this deploy in the history' : 'put back on its own if this deploy fails') + NL,
            );
          } catch (error: any) {
            await afs.appendFile(
              buildLogPath,
              `[${new Date().toISOString()}] DATABASE SNAPSHOT of ${db.dbName} failed: ${error?.message ?? error} — no way back from the migrations` + NL,
            );
            // asked to empty it: not without the way back
            if (config.resetDatabase) throw new Error(`Could not snapshot ${db.dbName} before resetting it: ${error?.message ?? error}`);
          }
          if (config.resetDatabase) {
            await resetDatabase(db.id);
            await afs.appendFile(buildLogPath, `[${new Date().toISOString()}] DATABASE RESET: ${db.dbName} emptied — the snapshot above is what it held` + NL);
          }
        }
        throwIfCancelled(key);
      }
      undoMigrations = async () => {
        if (wasLive || snapshots.length === 0) return;
        for (const snapshot of snapshots) {
          await afs.appendFile(buildLogPath, `[${new Date().toISOString()}] RESTORING DATABASE from the snapshot taken before this deploy…` + NL);
          const outcome = await restoreSnapshot(snapshot.databaseId, snapshot.file, deployment.userId, { wait: true }).catch((error: any) => ({
            status: 'FAILED',
            error: String(error?.message ?? error),
          }));
          await afs.appendFile(
            buildLogPath,
            outcome?.status === 'DONE'
              ? `[${new Date().toISOString()}] DATABASE RESTORED — as it was before the migrations` + NL
              : `[${new Date().toISOString()}] DATABASE RESTORE FAILED: ${outcome?.error ?? 'an import is already running there'} — restore it from the history row` + NL,
          );
        }
      };

      // Same commit, build settings and env as a build still on disk: that tree
      // is this deploy's build — nothing to install or compile again. For a
      // monorepo, the same for every one of its apps.
      const envs = new Map(group.map((app) => [app.id, app.id === application.id ? envVars : readEnv(app.envVars)]));
      const buildKey = commitSha ? groupBuildKey(group.map((app) => buildKeyOf(app, commitSha!, envs.get(app.id)!))) : null;
      const reused =
        buildKey && !group.some((app) => app.type === 'PHP') ? await this.reusableRelease(afs, application.id, buildKey) : null;
      if (reused) {
        await afs.appendFile(
          buildLogPath,
          `[${new Date().toISOString()}] Nothing changed since the build of ${commitSha!.slice(0, 7)} ` +
            `(same commit, build settings and environment) — reusing it, no rebuild.` + NL,
        );
      }
      const buildResult: BuildResult = reused
        ? { success: true, releaseDir: reused.path! }
        : await this.runBuild(afs, group, deployment, envs, config.resolveMigration, config.resolveAs, config.skipPreDeploy);
      // a stopped build fails — but that failure is the cancel, not the code;
      // and a build that finished still does not go live once cancel was asked
      throwIfCancelled(key);
      if (!buildResult.success) await undoMigrations();
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

      // One switch for every app of the source — they all run from `current`.
      // Each is then started (PHP: published); one that does not come up takes
      // the whole release back, so the apps never run different commits.
      const previousRelease = await this.activateRelease(afs, buildResult.releaseDir!);
      const failed: string[] = [];
      for (const app of group) {
        const ok =
          app.type === 'PHP'
            ? await this.publishPhp(app, afs, buildResult.docroots?.[app.id] ?? join(app.rootDirectory ?? '', '.'))
            : await this.startApplication(app.id);
        if (!ok) failed.push(app.name);
      }
      const startResult = failed.length === 0;

      let rolledBack = false;
      if (!startResult && previousRelease) {
        // Put the last good release back so the site stays up.
        await afs.appendFile(
          deployLogPath,
          `Rolling back to ${previousRelease}${group.length > 1 ? ` — ${failed.join(', ')} did not start` : ''}` + NL,
        );
        await this.activateRelease(afs, previousRelease);
        rolledBack = true;
        for (const app of group) {
          // PHP serves straight from `current`: switching it back is the rollback
          if (systemd.needsUnit(app.type)) rolledBack = (await this.startApplication(app.id).catch(() => false)) && rolledBack;
        }
        // a reused tree is a kept release — never this deploy's to delete
        if (!reused) await afs.rm(buildResult.releaseDir!, { recursive: true, force: true }).catch(() => {});
      }

      // the source's deploy log, then each app's own start log where it has one
      const readDeployLogs = async () => {
        const base = await readLog(deployLogPath, 'Deploy logs not available');
        const own = await Promise.all(
          group
            .filter((app) => ownDeployLogs.has(app.id))
            .map(async (app) => {
              const { afs: appAfs, path: file } = ownDeployLogs.get(app.id)!;
              return `==> ${app.name} <==` + NL + ((await appAfs.readText(file).catch(() => '')).trim() || '(nothing logged)');
            }),
        );
        return [base, ...own].join(NL + NL);
      };
      const deployLogs = await readDeployLogs();

      if (!startResult) {
        await prisma.deployment.update({
          where: { id: deployment.id },
          data: {
            status: 'FAILED',
            buildLogs,
            deployLogs,
          },
        });

        const what = group.length > 1 ? `${failed.join(', ')} failed to start` : 'Application failed to start';
        return {
          success: false,
          error: rolledBack ? `New release failed to start (${what}); the previous one is back up` : what,
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

      // runBuild gave the apps their ports; a reused build's are already on the rows
      const portOf = (app: Application) => app.port || this.getDefaultPort(app.type);

      // a reused build is already a release — one row per tree, or pruning the
      // older row would delete the tree the newer one serves from
      const release =
        reused ??
        (await prisma.release.create({
          data: {
            applicationId: application.id,
            sourceId: application.sourceId,
            commitSha: commitSha ?? null,
            status: 'READY',
            ports: Object.fromEntries(group.map((app) => [app.name, portOf(app)])),
            health: 'HEALTHY',
            logsRef: logsDir,
            path: buildResult.releaseDir ?? null,
            deploymentId: deployment.id,
            buildKey,
          },
        }));

      // the new release is live and recorded: whatever fell out of the rollback window goes
      await cleanupAppReleases(afs, application.id).catch(() => {});

      await prisma.application.update({
        where: { id: application.id },
        data: { activeReleaseId: release.id },
      });

      // The apps are up; without their routes the hostnames are not. Said first
      // in the deploy log (the line the history shows), not swallowed. They stay
      // RUNNING on purpose: the watchdog re-applies routes of running apps, so a
      // Caddy that was briefly unreachable heals on its own; an ERROR app never would.
      let routeWarning = '';
      for (const app of group) {
        if (app.type === 'PHP') continue;
        try {
          await serveApp(await serverForApplication(app.id), app.id, { kind: 'proxy', port: portOf(app) });
        } catch (error: any) {
          routeWarning +=
            `The app is running, but its Caddy route could not be set — ${app.name} is not served yet: ` +
            `${error?.message ?? String(error)}. The watchdog retries it; redeploy to try now.` + NL;
          console.error(`Caddy route for ${app.name} not set:`, error?.message ?? error);
        }
      }
      if (routeWarning) {
        await afs.appendFile(deployLogPath, routeWarning).catch(() => {});
        await prisma.deployment
          .update({ where: { id: deployment.id }, data: { deployLogs: routeWarning + deployLogs } })
          .catch(() => {});
      }

      return {
        success: true,
        buildLogs,
        deployLogs: routeWarning + deployLogs,
      };

    } catch (error: any) {
      // a migration that ran before the failure (or the cancel) is undone with the rest
      await undoMigrations?.().catch(() => {});
      if (error instanceof CancelledError) {
        // what was built so far stays in the build log; the reason goes first
        await prisma.deployment.update({
          where: { id: deployment.id },
          data: { status: 'CANCELLED', deployLogs: 'Cancelled — the previous release, if any, keeps serving' },
        });
        return { success: false, cancelled: true, error: 'Deployment cancelled' };
      }

      // the log up to where it broke, then why — not the reason alone ("Build exited with code 1")
      const soFar = readBuildLog ? (await readBuildLog().catch(() => '')).trimEnd() : '';
      const buildLogs = soFar ? `${soFar}\n\n${error.message}` : error.message;
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: { status: 'FAILED', buildLogs },
      });

      return {
        success: false,
        error: error.message,
        buildLogs,
      };
    }
  }

  /**
   * Get application status from its systemd unit
   */
  async getApplicationStatus(applicationId: string): Promise<'RUNNING' | 'STOPPED' | 'UNKNOWN' | 'ERROR'> {
    try {
      const application = await this.appWithOrg(applicationId);
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

      const afs = await sourceFsFor(deployment.applicationId);
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

      const afs = await sourceFsFor(deployment.applicationId);
      const name = logType === 'build' ? 'build' : logType === 'deploy' ? 'deploy' : 'combined';
      return this.tailLog(afs, join(logsDirFor(afs.appDir), `${name}-${deploymentId}.log`), lines, logType);
    } catch (error) {
      return `No logs available for ${logType}: ${error}`;
    }
  }

  /**
   * Get application logs from files
   */
  async getApplicationLogsFromFiles(applicationId: string, logType: string = 'combined', lines: number = 100): Promise<string> {
    try {
      // the build log is the source's; the unit's logs are the app's own
      const afs = logType === 'build' ? await sourceFsFor(applicationId) : await appFsFor(applicationId);

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
   * Check if build log exists for an app
   */
  async checkBuildLogExists(applicationId: string): Promise<{ exists: boolean; path: string; size?: number }> {
    try {
      const afs = await sourceFsFor(applicationId);

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
  async createTestBuildLog(applicationId: string, message: string = 'Test build log entry'): Promise<boolean> {
    try {
      const afs = await sourceFsFor(applicationId);

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
