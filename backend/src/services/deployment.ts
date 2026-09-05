import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Application, Deployment, Release } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { uploadBuildLog } from './s3Service';
import { configureCaddyForRuntimeApplication, configureCaddyForStaticApplication, configureCaddyForPhpApplication } from './caddyService';
import { appUnit } from './orgProvisionService';
import type { AppWithOrg } from './systemdService';
import { ensureSiteBucket, uploadSiteDirectory } from './r2Service';
import { resolveAppDir, resolveAppDirByDomain, releasesDirFor, currentDirFor, sharedDirFor } from '../lib/appPaths';
import { detectProject } from '../lib/projectDetect';
import * as systemd from './systemdService';
import * as http from 'http';
import * as net from 'net';

// Ports handed to runtime apps. Every app gets one for life; Caddy proxies to
// it on localhost. Apps must listen on $PORT — the health check enforces it.
const PORT_POOL_START = Number(process.env.APP_PORT_POOL_START || 20000);
const PORT_POOL_END = Number(process.env.APP_PORT_POOL_END || 29999);
const HEALTH_TIMEOUT_MS = Number(process.env.APP_HEALTH_TIMEOUT_MS || 60000);
const KEEP_RELEASES = 3;

const execAsync = promisify(exec);

const NL = '\n';

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

export interface StartResult {
  success: boolean;
  logs: string;
  error?: string;
}

/**
 * Application deployment.
 *
 * Apps build and run natively on the host: each one is a systemd unit owned by
 * its organization's OS user, inside that org's cgroup slice (see
 * systemdService and orgProvisionService). CPU/memory limits are the slice's,
 * so they are per organization rather than per app.
 */
export class DeploymentService {
  /**
   * Application directory, resolved through the owning organization so each
   * tenant's files sit under its own OS user's home. See lib/appPaths.ts.
   */
  private async getAppDir(applicationId: string): Promise<string> {
    return resolveAppDir(applicationId);
  }

  /** Load an application with the organization the runtime needs. */
  private async appWithOrg(domain: string) {
    return prisma.application.findFirst({
      where: { domain },
      include: { organization: { select: { slug: true } } },
    });
  }

  /** Same, for the log helpers that only carry a hostname. */
  private async getAppDirByDomain(domain: string): Promise<string> {
    const dir = await resolveAppDirByDomain(domain);
    if (!dir) throw new Error(`No application found for domain ${domain}`);
    return dir;
  }

  /**
   * Prepare the application directory using subdomain.domain.tld format
   */
  async prepareAppDirectory(applicationId: string): Promise<string> {
    const appDir = await this.getAppDir(applicationId);

    try {
      // Create app directory if it doesn't exist (parents included)
      await fs.mkdir(appDir, { recursive: true });

      const logsDir = path.join(appDir, 'logs');
      await fs.mkdir(logsDir, { recursive: true });

      const sourcesDir = path.join(appDir, 'sources');
      await fs.mkdir(sourcesDir, { recursive: true });

      return appDir;
    } catch (error) {
      throw new Error(`Failed to prepare app directory: ${error}`);
    }
  }

  /**
   * Clone or pull the repository into sources directory
   */
  async syncRepository(appDir: string, repository: string, branch: string = 'main'): Promise<string> {
    try {
      const sourcesDir = path.join(appDir, 'sources');

      // Check if directory is already a git repository
      const gitDir = path.join(sourcesDir, '.git');
      const gitExists = await fs.access(gitDir).then(() => true).catch(() => false);

      if (gitExists) {
        // Pull latest changes
        console.log(`Pulling latest changes for ${repository} on branch ${branch}`);
        await execAsync(`cd "${sourcesDir}" && git fetch origin && git reset --hard origin/${branch}`);
      } else {
        // Clone the repository
        console.log(`Cloning repository ${repository} on branch ${branch}`);
        await execAsync(`git clone -b ${branch} ${repository} "${sourcesDir}"`);
      }

      return sourcesDir;
    } catch (error) {
      throw new Error(`Failed to sync repository: ${error}`);
    }
  }

  private isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
  }

  /**
   * Give the app a port from the pool, once. Taken ports come from the DB
   * (including imported inventory) and the socket check catches anything else
   * on the box. A port already assigned is kept — the running release holds
   * it, which is not a conflict.
   */
  private async allocatePort(application: Application): Promise<number> {
    if (application.port) return application.port;

    const rows = await prisma.application.findMany({
      where: { port: { not: null } },
      select: { port: true },
    });
    const taken = new Set(rows.map((r) => r.port as number));

    for (let port = PORT_POOL_START; port <= PORT_POOL_END; port++) {
      if (taken.has(port)) continue;
      if (!(await this.isPortFree(port))) continue;
      await prisma.application.update({ where: { id: application.id }, data: { port } });
      application.port = port as any;
      return port;
    }
    throw new Error(`No free port left in ${PORT_POOL_START}-${PORT_POOL_END}`);
  }

  private getDefaultPort(type: string): number {
    return systemd.defaultPort(type);
  }

  /** Poll until something answers HTTP on the port. Any response counts — the app is up. */
  private waitForHealthy(port: number, timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const probe = () =>
      new Promise<boolean>((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3000 }, (res) => {
          res.resume();
          resolve(true);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
    return new Promise((resolve) => {
      const tick = async () => {
        if (await probe()) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 1000);
      };
      tick();
    });
  }

  /** Point `current` at a release. Symlink + rename, so the switch is atomic. */
  private async activateRelease(appDir: string, releaseDir: string): Promise<string | null> {
    const current = currentDirFor(appDir);
    const previous = await fs.readlink(current).catch(() => null);
    const tmp = current + '.tmp';
    await fs.rm(tmp, { force: true });
    await fs.symlink(releaseDir, tmp);
    await fs.rename(tmp, current);
    return previous;
  }

  private async pruneReleases(appDir: string): Promise<void> {
    const dir = releasesDirFor(appDir);
    const keep = await fs.readlink(currentDirFor(appDir)).catch(() => null);
    const names = (await fs.readdir(dir).catch(() => [] as string[])).sort();
    for (const name of names.slice(0, Math.max(0, names.length - KEEP_RELEASES))) {
      const full = path.join(dir, name);
      if (full === keep) continue;
      await fs.rm(full, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Build a fresh release: copy sources/ into releases/<stamp>, install and
   * build there. The tree that is serving is never touched, and rollback is a
   * symlink away. The tree is handed to the tenant user by cb-app-unit install.
   */
  async runBuild(
    appDir: string,
    application: Application,
    deployment: Deployment,
    envVars: Record<string, string> = {}
  ): Promise<BuildResult> {
    const sourcesDir = path.join(appDir, 'sources');
    const logsDir = path.join(appDir, 'logs');
    await fs.mkdir(logsDir, { recursive: true });
    const buildLogPath = path.join(logsDir, 'build.log');
    const log = (line: string) => fs.appendFile(buildLogPath, line + NL);

    try {
      if (systemd.needsUnit(application.type)) await this.allocatePort(application);

      await fs.writeFile(buildLogPath, `[${new Date().toISOString()}] BUILD STARTED` + NL);

      const detected = await detectProject(sourcesDir);
      await log(`Detected: ${detected.label} (${detected.packageManager})`);

      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
      const releaseDir = path.join(releasesDirFor(appDir), stamp);
      await fs.mkdir(releaseDir, { recursive: true });
      // ponytail: full copy per release, tar excludes the junk. Hardlink node_modules from the previous release if installs get slow.
      await execAsync(
        `tar -C "${sourcesDir}" --exclude=./node_modules --exclude=./.next --exclude=./.git -cf - . | tar -C "${releaseDir}" -xf -`,
        { timeout: 300000 }
      );

      if (detected.framework === 'nextjs') {
        // Next's build cache survives across releases — big win on rebuilds.
        const cache = path.join(sharedDirFor(appDir), 'next-cache');
        await fs.mkdir(cache, { recursive: true });
        await fs.mkdir(path.join(releaseDir, '.next'), { recursive: true });
        await fs.symlink(cache, path.join(releaseDir, '.next', 'cache'));
      }

      const has = (f: string) => fs.access(path.join(releaseDir, f)).then(() => true).catch(() => false);
      const steps: string[] = [];

      if (detected.type === 'PHP') {
        if (detected.installCommand) {
          if (await this.reuseInstalled(appDir, releaseDir, 'composer.lock', 'vendor')) {
            await log('vendor: composer.lock unchanged, hardlinked from the previous release');
          } else {
            steps.push(detected.installCommand);
          }
        }
        // Laravel and friends read .env from the app root. The platform's env
        // vars win over whatever the repository shipped.
        const entries = Object.entries(envVars).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
        if (entries.length > 0) {
          const shipped = await fs.readFile(path.join(releaseDir, '.env'), 'utf-8').catch(() => '');
          const kept = shipped.split(/\r?\n/).filter((line) => !entries.some(([k]) => line.startsWith(k + '=')));
          const own = entries.map(([k, v]) => `${k}="${String(v).replace(/(["\\$])/g, '\\$1')}"`);
          await fs.writeFile(path.join(releaseDir, '.env'), [...kept, ...own].join(NL) + NL);
        }
      } else if (await has('package.json')) {
        const lock = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock', bun: 'bun.lock' }[detected.packageManager];
        if (lock && (await this.reuseInstalled(appDir, releaseDir, lock, 'node_modules'))) {
          await log('node_modules: lockfile unchanged, hardlinked from the previous release');
        } else {
          steps.push(detected.installCommand);
        }
      }
      if (await has('requirements.txt')) steps.push('python3 -m pip install --user -r requirements.txt');
      const buildCommand = application.buildCommand || detected.buildCommand;
      if (buildCommand) steps.push(buildCommand);

      // NEXT_PUBLIC_* and friends are baked in at build time, so the app's env
      // must be present here. NODE_ENV stays unset: production would skip the
      // devDependencies most build tools live in.
      const env = { ...process.env, ...envVars, PORT: String(application.port), CI: '1', NEXT_TELEMETRY_DISABLED: '1' };
      delete (env as any).NODE_ENV;

      for (const step of steps) {
        await log(NL + `$ ${step}`);
        const { stdout, stderr } = await execAsync(step, { cwd: releaseDir, timeout: 900000, env, maxBuffer: 64 * 1024 * 1024 });
        await log(stdout + (stderr ? NL + stderr : ''));
      }

      await log(NL + `[${new Date().toISOString()}] BUILD COMPLETED`);
      await uploadBuildLog(buildLogPath, application.id, deployment.id).catch(() => {});
      return { success: true, releaseDir, docroot: detected.outputDir || '.' };
    } catch (error: any) {
      const message = error.stderr || error.message || String(error);
      await log(NL + `[${new Date().toISOString()}] BUILD FAILED:` + NL + message);
      await uploadBuildLog(buildLogPath, application.id, deployment.id).catch(() => {});
      return { success: false, error: message };
    }
  }

  /**
   * Same lockfile as the release that is live → hardlink its node_modules (or
   * vendor/) and skip the install. Saves the disk of a full copy and most of
   * the build time. Hardlinks are safe here: both releases belong to the same
   * tenant user.
   */
  private async reuseInstalled(appDir: string, releaseDir: string, lock: string, dir: string): Promise<boolean> {
    const previous = await fs.readlink(currentDirFor(appDir)).catch(() => null);
    if (!previous) return false;
    const [a, b] = await Promise.all([
      fs.readFile(path.join(previous, lock)).catch(() => null),
      fs.readFile(path.join(releaseDir, lock)).catch(() => null),
    ]);
    if (!a || !b || !a.equals(b)) return false;
    const prevDir = path.join(previous, dir);
    if (!(await fs.stat(prevDir).then((s) => s.isDirectory()).catch(() => false))) return false;
    // ponytail: cp -al, GNU coreutils. Fall back to a real install if it fails.
    return execAsync(`cp -al "${prevDir}" "${path.join(releaseDir, dir)}"`, { timeout: 300000 })
      .then(() => true)
      .catch(() => false);
  }

  /**
   * PHP apps have no unit: the org's PHP-FPM pool serves them. Publishing is
   * handing the tree to the tenant user and pointing Caddy at the docroot.
   */
  private async publishPhp(application: AppWithOrg, appDir: string, docroot: string): Promise<boolean> {
    const slug = application.organization?.slug;
    if (!slug) throw new Error('PHP apps need an organization (the FPM pool is per org)');

    const deployLogPath = path.join(appDir, 'logs', 'deploy.log');
    await appUnit('chown', slug, application.id);

    const socketDir = process.env.PHP_FPM_SOCKET_DIR || '/run/php';
    const sockets = (await fs.readdir(socketDir).catch(() => [] as string[])).filter((n) =>
      new RegExp(`^php[0-9.]+-fpm-cb-${slug}\\.sock$`).test(n)
    );
    if (sockets.length === 0) {
      await fs.appendFile(deployLogPath, `No PHP-FPM pool socket for this organization in ${socketDir}. Re-provision the organization with PHP-FPM installed.` + NL);
      return false;
    }
    const socket = path.join(socketDir, sockets.sort().reverse()[0] as string);
    const root = path.join(currentDirFor(appDir), docroot);

    await configureCaddyForPhpApplication(application.domain, root, socket);
    await fs.appendFile(deployLogPath, `PHP: ${root} via ${socket}` + NL);
    return true;
  }

  /**
   * (Re)install and start the unit for an application, by hostname.
   */
  async startApplication(domain: string): Promise<boolean> {
    try {
      const application = await this.appWithOrg(domain);
      if (!application) {
        throw new Error('Application not found for domain');
      }

      const appDir = await this.getAppDir(application.id);
      const logsDir = path.join(appDir, 'logs');
      const deployLogPath = path.join(logsDir, 'deploy.log');
      await fs.mkdir(logsDir, { recursive: true });

      await fs.appendFile(deployLogPath, `[${new Date().toISOString()}] DEPLOYMENT STARTED` + NL);

      let started = await systemd.startApplication(application);

      if (started && systemd.needsUnit(application.type)) {
        const port = application.port || this.getDefaultPort(application.type);
        await fs.appendFile(deployLogPath, `Waiting for the app to answer on 127.0.0.1:${port}` + NL);
        started = await this.waitForHealthy(port);
        if (!started) {
          await fs.appendFile(
            deployLogPath,
            `Nothing answered on port ${port} within ${HEALTH_TIMEOUT_MS / 1000}s. The app must listen on $PORT (${port}). Check logs/error.log.` + NL
          );
        }
      }

      await fs.appendFile(
        deployLogPath,
        `[${new Date().toISOString()}] DEPLOYMENT ${started ? 'COMPLETED' : 'FAILED'}` + NL
      );

      return started;
    } catch (error) {
      const message = (error as any).stderr || (error as any).message || String(error);
      try {
        const appDir = await this.getAppDirByDomain(domain);
        const deployLogPath = path.join(appDir, 'logs', 'deploy.log');
        await fs.appendFile(deployLogPath, `[${new Date().toISOString()}] DEPLOYMENT FAILED:` + NL + message + NL);
      } catch {
      }

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

    const appDir = await this.getAppDir(application.id);
    const deployLogPath = path.join(appDir, 'logs', 'deploy.log');
    await fs.mkdir(path.join(appDir, 'logs'), { recursive: true });
    await fs.appendFile(deployLogPath, `[${new Date().toISOString()}] RELEASE STARTED: ${release.id}` + NL);

    if (release.path) {
      const exists = await fs.stat(release.path).then((st) => st.isDirectory()).catch(() => false);
      if (!exists) throw new Error(`Release directory is gone: ${release.path}`);
      await this.activateRelease(appDir, release.path);
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

  /**
   * Full deployment process
   */
  async deploy(config: DeploymentConfig): Promise<{
    success: boolean;
    error?: string;
    buildLogs?: string;
    deployLogs?: string;
  }> {
    const { application, deployment, envVars = {} } = config;
    let commitSha: string | undefined;

    try {
      console.log(`Starting deployment for application: ${application.name}`);

      // Update deployment status to BUILDING
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: { status: 'BUILDING' },
      });

      const appDir = await this.prepareAppDirectory(application.id);

      // Clear build logs for this deployment
      const logsDir = path.join(appDir, 'logs');
      const buildLogPath = path.join(logsDir, 'build.log');
      const deployLogPath = path.join(logsDir, 'deploy.log');

      // Ensure logs directory exists
      await fs.mkdir(logsDir, { recursive: true });

      // Clear build and deploy logs for fresh deployment
      await fs.writeFile(buildLogPath, '');
      await fs.writeFile(deployLogPath, '');

      console.log(`Cleared build logs for deployment: ${deployment.id}`);

      if (application.repository) {
        const branch = application.branch || 'main';
        await this.syncRepository(appDir, application.repository, branch);
        try {
          const sourcesDir = path.join(appDir, 'sources');
          const { stdout: commitStdout } = await execAsync(`cd "${sourcesDir}" && git rev-parse HEAD`);
          commitSha = commitStdout.trim();
        } catch (error) {
        }
      }

      if (application.type === 'STATIC') {
        const sourcesDir = path.join(appDir, 'sources');
        // Uploaded static sites already live in object storage — a redeploy has
        // nothing to build, so keep the deployment green instead of running a
        // build command against an empty sources tree.
        const prebuilt = !application.repository && !application.buildCommand;
        const buildCommand = application.buildCommand || 'npm run build';

        if (prebuilt) {
          const uploadTimestamp = new Date().toISOString();
          await fs.appendFile(buildLogPath, `[${uploadTimestamp}] UPLOADED SOURCES — no build step
`);

          await uploadBuildLog(buildLogPath, application.id, deployment.id).catch(() => {});

          const buildLogs = await fs.readFile(buildLogPath, 'utf-8').catch(() => 'Build logs not available');

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

          try {
            await configureCaddyForStaticApplication(
              application.id,
              application.domain,
              (application as any).staticOrigin
            );
          } catch {
          }

          return {
            success: true,
            buildLogs,
            deployLogs: 'Uploaded files are already served from Cloudflare R2',
          };
        }

        const staticBuildEnv = {
          ...process.env,
          ...envVars,
          NODE_ENV: 'production',
        };

        try {
          const staticStartTimestamp = new Date().toISOString();
          await fs.appendFile(buildLogPath, `[${staticStartTimestamp}] STATIC BUILD STARTED\n`);

          const { stdout, stderr } = await execAsync(buildCommand, {
            cwd: sourcesDir,
            timeout: 600000,
            env: staticBuildEnv,
          });

          const staticCompletionTimestamp = new Date().toISOString();
          const staticBuildLogEntry = `[${staticCompletionTimestamp}] STATIC BUILD COMPLETED:\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}\n\n`;
          await fs.appendFile(buildLogPath, staticBuildLogEntry);

          const distCandidates = ['dist', 'build'];
          let distDir: string | null = null;
          for (const candidate of distCandidates) {
            const candidatePath = path.join(sourcesDir, candidate);
            const exists = await fs
              .access(candidatePath)
              .then(() => true)
              .catch(() => false);
            if (exists) {
              distDir = candidatePath;
              break;
            }
          }

          if (!distDir) {
            throw new Error('Static build directory not found (expected dist/ or build/)');
          }

          const { bucket, origin } = await ensureSiteBucket(application.domain);
          await uploadSiteDirectory(bucket, distDir);

          await prisma.application.update({
            where: { id: application.id },
            data: { staticBucket: bucket, staticOrigin: origin },
          });
          (application as any).staticOrigin = origin;

          await uploadBuildLog(buildLogPath, application.id, deployment.id).catch(() => {});

          const buildLogs = await fs.readFile(buildLogPath, 'utf-8').catch(() => 'Build logs not available');

          await prisma.deployment.update({
            where: { id: deployment.id },
            data: {
              status: 'SUCCESS',
              buildLogs,
              deployLogs: 'Static site deployed to Cloudflare R2',
            },
          });

          await prisma.application.update({
            where: { id: application.id },
            data: {
              status: 'RUNNING',
              lastDeployment: new Date(),
            },
          });

          try {
            await configureCaddyForStaticApplication(
              application.id,
              application.domain,
              (application as any).staticOrigin
            );
          } catch {
          }

          return {
            success: true,
            buildLogs,
            deployLogs: 'Static site deployed to Cloudflare R2',
          };
        } catch (error: any) {
          const errorTimestamp = new Date().toISOString();
          const message = error.stderr || error.message || String(error);
          const errorLogEntry = `[${errorTimestamp}] STATIC BUILD FAILED:\n${message}\n\n`;
          await fs.appendFile(buildLogPath, errorLogEntry);
          await uploadBuildLog(buildLogPath, application.id, deployment.id).catch(() => {});

          const buildLogs = await fs.readFile(buildLogPath, 'utf-8').catch(() => 'Build logs not available');

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

      const buildResult = await this.runBuild(appDir, application, deployment, envVars);

      // Get build logs
      let buildLogs = '';
      try {
        buildLogs = await fs.readFile(buildLogPath, 'utf-8');
        if (!buildLogs.trim()) {
          buildLogs = 'Build logs not available';
        }
      } catch (error) {
        buildLogs = 'Build logs not available';
      }

      if (!buildResult.success) {
        // Update deployment with failure
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

      const previousRelease = await this.activateRelease(appDir, buildResult.releaseDir!);
      let startResult =
        application.type === 'PHP'
          ? await this.publishPhp((await this.appWithOrg(application.domain))!, appDir, buildResult.docroot || '.')
          : await this.startApplication(application.domain);

      if (!startResult && previousRelease) {
        // Put the last good release back so the site stays up.
        await fs.appendFile(deployLogPath, `Rolling back to ${previousRelease}` + NL);
        await this.activateRelease(appDir, previousRelease);
        await this.startApplication(application.domain).catch(() => false);
        await fs.rm(buildResult.releaseDir!, { recursive: true, force: true }).catch(() => {});
      }

      let deployLogs = '';
      try {
        deployLogs = await fs.readFile(deployLogPath, 'utf-8');
        if (!deployLogs.trim()) {
          deployLogs = 'Deploy logs not available';
        }
      } catch (error) {
        deployLogs = 'Deploy logs not available';
      }

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
          error: 'Application failed to start',
          buildLogs,
          deployLogs,
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
        },
      });

      await this.pruneReleases(appDir).catch(() => {});

      await prisma.application.update({
        where: { id: application.id },
        data: { activeReleaseId: release.id },
      });

      if (application.type !== 'PHP') {
        try {
          await configureCaddyForRuntimeApplication(application.domain, port);
        } catch {
        }
      }

      return {
        success: true,
        buildLogs,
        deployLogs,
      };

    } catch (error: any) {
      // Update deployment with error
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
  async getApplicationStatus(domain: string): Promise<'RUNNING' | 'STOPPED' | 'ERROR'> {
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

      // Get deployment info from database
      const deployment = await prisma.deployment.findUnique({
        where: { id: deploymentId },
        include: {
          application: {
            select: { domain: true }
          }
        }
      });

      if (!deployment) {
        return false;
      }

      const appDir = await this.getAppDir(deployment.applicationId);
      const logsDir = path.join(appDir, 'logs');
      const buildLogPath = path.join(logsDir, 'build.log');
      const deployLogPath = path.join(logsDir, 'deploy.log');

      await fs.writeFile(buildLogPath, '');
      await fs.writeFile(deployLogPath, '');

      console.log(`Cleared logs for deployment: ${deploymentId}`);
      return true;
    } catch (error) {
      console.error('Error clearing deployment logs:', error);
      return false;
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

      // Get deployment info from database
      const deployment = await prisma.deployment.findUnique({
        where: { id: deploymentId },
        include: {
          application: {
            select: { domain: true }
          }
        }
      });

      if (!deployment) {
        return 'Deployment not found';
      }

      const appDir = await this.getAppDir(deployment.applicationId);
      const logsDir = path.join(appDir, 'logs');

      let logFile = '';
      switch (logType) {
        case 'build':
          logFile = path.join(logsDir, `build-${deploymentId}.log`);
          break;
        case 'deploy':
          logFile = path.join(logsDir, `deploy-${deploymentId}.log`);
          break;
        default:
          logFile = path.join(logsDir, `combined-${deploymentId}.log`);
      }

      // Check if log file exists
      const logExists = await fs.access(logFile).then(() => true).catch(() => false);
      if (!logExists) {
        return `Log file not found: ${logFile}`;
      }

      const logContent = await fs.readFile(logFile, 'utf-8');
      const logLines = logContent.split('\n').slice(-lines).join('\n');
      return logLines;
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

      const appDir = await this.getAppDirByDomain(domain);
      const logsDir = path.join(appDir, 'logs');

      let logFile = '';
      switch (logType) {
        case 'out':
          logFile = path.join(logsDir, 'out.log');
          break;
        case 'error':
          logFile = path.join(logsDir, 'error.log');
          break;
        case 'build':
          logFile = path.join(logsDir, 'build.log');
          break;
        default:
          logFile = path.join(logsDir, 'combined.log');
      }

      // Check if log file exists
      const logExists = await fs.access(logFile).then(() => true).catch(() => false);
      if (!logExists) {
        return `Log file not found: ${logFile}`;
      }

      const logContent = await fs.readFile(logFile, 'utf-8');
      const logLines = logContent.split('\n').slice(-lines).join('\n');
      return logLines;
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

      const appDir = await this.getAppDirByDomain(domain);
      const logsDir = path.join(appDir, 'logs');
      const buildLogPath = path.join(logsDir, 'build.log');

      const exists = await fs.access(buildLogPath).then(() => true).catch(() => false);

      if (exists) {
        const stats = await fs.stat(buildLogPath);
        return {
          exists: true,
          path: buildLogPath,
          size: stats.size
        };
      }

      return {
        exists: false,
        path: buildLogPath
      };
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

      const appDir = await this.getAppDirByDomain(domain);
      const logsDir = path.join(appDir, 'logs');

      // Ensure logs directory exists
      await fs.mkdir(logsDir, { recursive: true });

      const buildLogPath = path.join(logsDir, 'build.log');
      const timestamp = new Date().toISOString();
      const testEntry = `[${timestamp}] TEST: ${message}\n`;

      await fs.appendFile(buildLogPath, testEntry);
      console.log(`Test build log entry created at: ${buildLogPath}`);
      return true;
    } catch (error) {
      console.error(`Failed to create test build log: ${error}`);
      return false;
    }
  }
}
