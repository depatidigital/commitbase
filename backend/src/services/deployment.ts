import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Application, Deployment, Release } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { uploadBuildLog } from './s3Service';
import { configureCaddyForRuntimeApplication, configureCaddyForStaticApplication } from './caddyService';
import { ensureSiteBucket, uploadSiteDirectory } from './r2Service';
import { resolveAppDir, resolveAppDirByDomain } from '../lib/appPaths';
import * as systemd from './systemdService';

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

  /**
   * Find an available port starting from the requested port
   */
  private async findAvailablePort(requestedPort: number): Promise<number> {
    const net = require('net');

    const isPortAvailable = (port: number): Promise<boolean> => {
      return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(port, () => {
          server.once('close', () => {
            resolve(true);
          });
          server.close();
        });
        server.on('error', () => {
          resolve(false);
        });
      });
    };

    if (await isPortAvailable(requestedPort)) {
      return requestedPort;
    }

    let port = requestedPort + 1;
    const maxAttempts = 100; // Prevent infinite loop

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (await isPortAvailable(port)) {
        console.log(`Port ${requestedPort} is busy, using port ${port} instead`);
        return port;
      }
      port++;
    }

    throw new Error(`No available ports found starting from ${requestedPort}`);
  }

  /**
   * Get default port for application type
   */
  private getDefaultPort(type: string): number {
    return systemd.defaultPort(type);
  }

  /**
   * Build in place: dependencies plus the app's own build command, run in the
   * sources tree. The tree is handed to the tenant user by cb-app-unit install,
   * which runs at start.
   */
  async runBuild(appDir: string, application: Application, deployment: Deployment): Promise<BuildResult> {
    const sourcesDir = path.join(appDir, 'sources');
    const logsDir = path.join(appDir, 'logs');
    await fs.mkdir(logsDir, { recursive: true });
    const buildLogPath = path.join(logsDir, 'build.log');

    try {
      const requestedPort = application.port || this.getDefaultPort(application.type);
      const availablePort = await this.findAvailablePort(requestedPort);
      if (availablePort !== requestedPort) {
        await prisma.application.update({
          where: { id: application.id },
          data: { port: availablePort },
        });
        application.port = availablePort as any;
      }

      await fs.writeFile(buildLogPath, `[${new Date().toISOString()}] BUILD STARTED` + NL);

      const steps: string[] = [];
      const has = (f: string) => fs.access(path.join(sourcesDir, f)).then(() => true).catch(() => false);

      if (await has('package.json')) steps.push('npm install --no-audit --no-fund');
      if (await has('requirements.txt')) steps.push('python3 -m pip install --user -r requirements.txt');
      if (application.buildCommand) steps.push(application.buildCommand);

      for (const step of steps) {
        await fs.appendFile(buildLogPath, NL + `$ ${step}` + NL);
        const { stdout, stderr } = await execAsync(step, { cwd: sourcesDir, timeout: 900000 });
        await fs.appendFile(buildLogPath, stdout + (stderr ? NL + stderr : '') + NL);
      }

      await fs.appendFile(buildLogPath, NL + `[${new Date().toISOString()}] BUILD COMPLETED` + NL);
      await uploadBuildLog(buildLogPath, application.id, deployment.id).catch(() => {});
      return { success: true };
    } catch (error: any) {
      const message = error.stderr || error.message || String(error);
      await fs.appendFile(buildLogPath, NL + `[${new Date().toISOString()}] BUILD FAILED:` + NL + message + NL);
      await uploadBuildLog(buildLogPath, application.id, deployment.id).catch(() => {});
      return { success: false, error: message };
    }
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

      const started = await systemd.startApplication(application);

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

      const buildResult = await this.runBuild(appDir, application, deployment);

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

      const startResult = await this.startApplication(application.domain);

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
          health: 'UNKNOWN',
          logsRef: logsDir,
        },
      });

      await prisma.application.update({
        where: { id: application.id },
        data: { activeReleaseId: release.id },
      });

      try {
        await configureCaddyForRuntimeApplication(application.domain, port);
      } catch {
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
