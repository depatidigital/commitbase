import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Application, Deployment, Release } from '@prisma/client';
import { prisma } from '../lib/prisma';
import * as crypto from 'crypto';
import { TemplateEngine, TemplateData } from '../utils/templateEngine';
import { uploadBuildLog, uploadDirectoryToS3 } from './s3Service';
import { configureCaddyForRuntimeApplication, configureCaddyForStaticApplication } from './caddyService';

const execAsync = promisify(exec);

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
  pid?: number | undefined;
}

export function getDockerContainerName(application: Application) {
  return application.domain;
}

export class DeploymentService {
  private baseDir: string;
  private templateEngine: TemplateEngine;

  constructor() {
    this.baseDir = process.env.APPS_DIR || path.join(process.cwd(), 'apps_dir');
    this.templateEngine = new TemplateEngine();
  }

  private getAppDir(applicationId: string): string {
    return path.join(this.baseDir, applicationId);
  }

  /**
   * Prepare the application directory using subdomain.domain.tld format
   */
  async prepareAppDirectory(applicationId: string): Promise<string> {
    const appDir = this.getAppDir(applicationId);

    try {
      // Create apps_dir directory if it doesn't exist
      await fs.mkdir(this.baseDir, { recursive: true });

      // Create app directory if it doesn't exist
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
   * Install dependencies in sources directory
   */
  async installDependencies(appDir: string): Promise<string> {
    try {
      console.log('Installing dependencies...');

      const sourcesDir = path.join(appDir, 'sources');

      // Check if package.json exists
      const packageJsonPath = path.join(sourcesDir, 'package.json');
      const packageExists = await fs.access(packageJsonPath).then(() => true).catch(() => false);

      if (packageExists) {
        await execAsync(`cd "${sourcesDir}" && npm install`);
      } else {
        console.log('No package.json found, skipping npm install');
      }

      return 'Dependencies installed successfully';
    } catch (error) {
      throw new Error(`Failed to install dependencies: ${error}`);
    }
  }


  /**
   * Generate Docker container name for application
   */
  private generateContainerName(domain: string): string {
    const sanitizedDomain = domain.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    return `${sanitizedDomain}`;
  }

  /**
   * Create Dockerfile for the application using templates
   */
  async createDockerfile(appDir: string, application: Application): Promise<string> {
    const sourcesDir = path.join(appDir, 'sources');
    const dockerfilePath = path.join(sourcesDir, 'Dockerfile');

    // Map application types to template names
    const templateMap: Record<string, string> = {
      'NODEJS': 'nodejs',
      'STATIC': 'static',
      'PYTHON': 'python',
      'GO': 'go',
      'RUST': 'rust',
      'PHP': 'php',
      'JAVA': 'java'
    };

    const templateName = templateMap[application.type];
    if (!templateName) {
      throw new Error(`Unsupported application type: ${application.type}`);
    }

    // Prepare template data
    const templateData: TemplateData = {
      port: application.port || this.getDefaultPort(application.type),
      startCommand: application.startCommand || this.getDefaultStartCommand(application.type),
      buildCommand: application.buildCommand || '',
      nginxConfig: false // Will be set to true if nginx.conf exists
    };

    // Check for nginx.conf for static sites
    if (application.type === 'STATIC') {
      const nginxConfigPath = path.join(sourcesDir, 'nginx.conf');
      try {
        await fs.access(nginxConfigPath);
        templateData.nginxConfig = true;
      } catch {
        // nginx.conf doesn't exist, use default
      }
    }

    // Validate template data
    const validation = this.templateEngine.validateTemplateData(templateName, templateData);
    if (!validation.valid) {
      throw new Error(`Template validation failed: ${validation.errors.join(', ')}`);
    }

    // Render template
    const dockerfileContent = await this.templateEngine.renderTemplate(templateName, templateData);

    // Write Dockerfile
    await fs.writeFile(dockerfilePath, dockerfileContent);
    return dockerfilePath;
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

    // Check if port is used by Docker containers
    const isPortUsedByDocker = async (port: number): Promise<boolean> => {
      try {
        const { stdout } = await execAsync(`docker ps --format "table {{.Ports}}" | grep ":${port}->"`);
        return stdout.trim().length > 0;
      } catch (error) {
        // If grep doesn't find anything, port is not used by Docker
        return false;
      }
    };

    // Try the requested port first
    if (await isPortAvailable(requestedPort) && !(await isPortUsedByDocker(requestedPort))) {
      return requestedPort;
    }

    // If requested port is not available, find the next available port
    let port = requestedPort + 1;
    const maxAttempts = 100; // Prevent infinite loop
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (await isPortAvailable(port) && !(await isPortUsedByDocker(port))) {
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
    const defaultPorts: Record<string, number> = {
      'NODEJS': 3000,
      'STATIC': 80,
      'PYTHON': 8000,
      'GO': 8080,
      'RUST': 8080,
      'PHP': 80,
      'JAVA': 8080
    };
    return defaultPorts[type] || 3000;
  }

  /**
   * Get default start command for application type
   */
  private getDefaultStartCommand(type: string): string {
    const defaultCommands: Record<string, string> = {
      'NODEJS': 'npm start',
      'STATIC': 'nginx -g "daemon off;"',
      'PYTHON': 'python app.py',
      'GO': './main',
      'RUST': './app',
      'PHP': 'apache2-foreground',
      'JAVA': 'java -jar app.jar'
    };
    return defaultCommands[type] || 'npm start';
  }

  private getImageName(application: Application, deployment: Deployment): string {
    const repository = `app-${application.id.toLowerCase()}`;
    const tag = deployment.id.toLowerCase();
    return `${repository}:${tag}`;
  }

  /**
   * Format environment variables for Docker Compose
   */
  private formatEnvironmentVariables(envVars: Record<string, string>): string {
    if (Object.keys(envVars).length === 0) {
      return '';
    }
    return '\n' + Object.entries(envVars)
      .map(([key, value]) => `      - ${key}=${value}`)
      .join('\n');
  }

  /**
   * Get health check configuration for application type
   */
  private getHealthCheck(type: string): string {
    const healthChecks: Record<string, string> = {
      'NODEJS': '["CMD", "curl", "-f", "http://localhost:3000/health"]',
      'PYTHON': '["CMD", "curl", "-f", "http://localhost:8000/health"]',
      'GO': '["CMD", "curl", "-f", "http://localhost:8080/health"]',
      'RUST': '["CMD", "curl", "-f", "http://localhost:8080/health"]',
      'JAVA': '["CMD", "curl", "-f", "http://localhost:8080/health"]',
      'PHP': '["CMD", "curl", "-f", "http://localhost:80/health"]',
      'STATIC': '["CMD", "curl", "-f", "http://localhost:80/health"]'
    };

    const healthCheck = healthChecks[type];
    if (!healthCheck) {
      return '';
    }

    return `    healthcheck:
      test: ${healthCheck}
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s`;
  }

  /**
   * Get resource limits configuration
   */
  private getResourceLimits(application: Application): string {
    const memoryLimit = application.memory || '512M';
    const cpuLimit = application.cpu || '0.5';
    const memoryReservation = this.calculateMemoryReservation(memoryLimit);
    const cpuReservation = this.calculateCpuReservation(cpuLimit);

    return `deploy:
      resources:
        limits:
          memory: ${memoryLimit}
          cpus: '${cpuLimit}'
        reservations:
          memory: ${memoryReservation}
          cpus: '${cpuReservation}'`;
  }

  private getDockerResourceFlags(application: Application): string[] {
    const flags: string[] = [];
    const memoryLimit = application.memory || '512M';
    const cpuLimit = application.cpu || '0.5';
    const normalizedMemory = this.normalizeMemoryLimit(memoryLimit);

    flags.push(`--memory=${normalizedMemory}`);
    flags.push(`--cpus=${cpuLimit}`);

    return flags;
  }

  private normalizeMemoryLimit(memoryLimit: string): string {
    const trimmed = memoryLimit.trim();
    if (!trimmed) {
      return '512m';
    }
    const lower = trimmed.toLowerCase();
    if (/[mg]$/.test(lower)) {
      return lower;
    }
    return `${lower}m`;
  }

  /**
   * Calculate memory reservation (50% of limit)
   */
  private calculateMemoryReservation(memoryLimit: string): string {
    const value = parseInt(memoryLimit);
    const unit = memoryLimit.replace(/[0-9]/g, '');
    const reservation = Math.floor(value * 0.5);
    return `${reservation}${unit}`;
  }

  /**
   * Calculate CPU reservation (50% of limit)
   */
  private calculateCpuReservation(cpuLimit: string): string {
    const value = parseFloat(cpuLimit);
    const reservation = (value * 0.5).toFixed(2);
    return reservation;
  }

  /**
   * Create .dockerignore file
   */
  async createDockerignore(appDir: string): Promise<string> {
    const sourcesDir = path.join(appDir, 'sources');
    const dockerignorePath = path.join(sourcesDir, '.dockerignore');

    const dockerignoreContent = `node_modules
npm-debug.log
.git
.gitignore
README.md
.env
.nyc_output
coverage
.DS_Store
*.log
dist
build
.cache
.parcel-cache`;

    await fs.writeFile(dockerignorePath, dockerignoreContent);
    return dockerignorePath;
  }

  /**
   * Build Docker image for the application
   */
  async runDockerCompose(appDir: string, application: Application, deployment: Deployment): Promise<BuildResult> {
    try {
      const sourcesDir = path.join(appDir, 'sources');
      const logsDir = path.join(appDir, 'logs');
      await fs.mkdir(logsDir, { recursive: true });

      const requestedPort = application.port || this.getDefaultPort(application.type);
      const availablePort = await this.findAvailablePort(requestedPort);

      if (availablePort !== requestedPort) {
        await prisma.application.update({
          where: { id: application.id },
          data: { port: availablePort }
        });
        application.port = availablePort as any;
      }

      const buildLogPath = path.join(logsDir, 'build.log');
      const timestamp = new Date().toISOString();

      await fs.writeFile(buildLogPath, `[${timestamp}] DOCKER BUILD STARTED\n`);

      await this.createDockerfile(appDir, application);

      await this.createDockerignore(appDir);

      const imageName = this.getImageName(application, deployment);
      const memoryLimit = application.memory || '512M';
      const normalizedMemory = this.normalizeMemoryLimit(memoryLimit);
      const buildCommand = `docker build --memory=${normalizedMemory} -t ${imageName} .`;

      const { stdout, stderr } = await execAsync(buildCommand, {
        cwd: sourcesDir,
        timeout: 600000,
        env: {
          ...process.env,
          DOCKER_BUILDKIT: '1',
        },
      });

      const completionTimestamp = new Date().toISOString();
      const buildLogEntry = `[${completionTimestamp}] DOCKER BUILD COMPLETED:\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}\n\n`;
      await fs.appendFile(buildLogPath, buildLogEntry);

      await uploadBuildLog(buildLogPath, application.id, deployment.id).catch(() => {});
      await this.enforceImageRetentionPolicy(application).catch(() => {});

      return {
        success: true,
      };
    } catch (error: any) {
      const logsDir = path.join(appDir, 'logs');
      const buildLogPath = path.join(logsDir, 'build.log');
      const errorTimestamp = new Date().toISOString();
      const message = error.stderr || error.message || String(error);
      const errorLogEntry = `[${errorTimestamp}] DOCKER BUILD FAILED:\n${message}\n\n`;
      await fs.appendFile(buildLogPath, errorLogEntry);

      await uploadBuildLog(buildLogPath, application.id, deployment.id).catch(() => {});

      return {
        success: false,
        error: message,
      };
    }
  }

  /**
   * Start the application using Docker
   */
  async startApplication(appDir: string): Promise<StartResult> {
    try {
      const domain = path.basename(appDir);
      const started = await this.startDockerCompose(domain);

      if (started) {
        const containerName = domain;
        const containerId = await this.getDockerContainerId(containerName);
        return {
          success: true,
          logs: `Application started successfully with Docker (${containerName})`,
          pid: undefined,
        };
      }

      return {
        success: false,
        logs: '',
        error: 'Application failed to start with Docker',
      };
    } catch (error: any) {
      return {
        success: false,
        logs: '',
        error: error.message,
      };
    }
  }

  /**
   * Check if Docker container is running
   */
  private async checkDockerContainerRunning(containerName: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`docker ps --filter "name=${containerName}" --format "table {{.Names}}\t{{.Status}}"`);
      return stdout.includes(containerName) && stdout.includes('Up');
    } catch {
      return false;
    }
  }

  /**
   * Get Docker container ID
   */
  private async getDockerContainerId(containerName: string): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync(`docker ps --filter "name=${containerName}" --format "{{.ID}}"`);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Stop the application using Docker
   */
  async stopApplication(containerName?: string): Promise<boolean> {
    try {
      if (containerName) {
        await execAsync(`docker stop ${containerName}`);
        await execAsync(`docker rm ${containerName}`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to stop Docker application:', error);
      return false;
    }
  }

  /**
   * Start Docker Compose for an application
   */
  async startDockerCompose(domain: string): Promise<boolean> {
    try {
      const application = await prisma.application.findFirst({
        where: { domain },
      });

      if (!application) {
        throw new Error('Application not found for domain');
      }

      const appDir = this.getAppDir(application.id);
      const logsDir = path.join(appDir, 'logs');
      const deployLogPath = path.join(logsDir, 'deploy.log');

      await fs.mkdir(logsDir, { recursive: true });

      let imageName: string | undefined;

      if (application.activeReleaseId) {
        const activeRelease = await prisma.release.findUnique({
          where: { id: application.activeReleaseId },
        });

        if (activeRelease && activeRelease.status === 'READY') {
          imageName = activeRelease.imageTag;
        }
      }

      if (!imageName) {
        const deployment = await prisma.deployment.findFirst({
          where: {
            applicationId: application.id,
            status: 'SUCCESS',
          },
          orderBy: {
            createdAt: 'desc',
          },
        });

        if (!deployment) {
          throw new Error('No successful deployment found for application');
        }

        imageName = this.getImageName(application, deployment);
      }

      const startTimestamp = new Date().toISOString();
      await fs.appendFile(deployLogPath, `[${startTimestamp}] DEPLOYMENT STARTED\n`);

      const containerName = domain;

      try {
        await execAsync(`docker stop ${containerName} || true`);
        await execAsync(`docker rm ${containerName} || true`);
      } catch (error) {
      }

      const requestedPort = application.port || this.getDefaultPort(application.type);
      const hostPort = await this.findAvailablePort(requestedPort);

      if (hostPort !== requestedPort) {
        await prisma.application.update({
          where: { id: application.id },
          data: { port: hostPort },
        });
        (application as any).port = hostPort;
      }

      const containerPort = requestedPort;

      const envParts: string[] = [];
      const envVars = (application.envVars || {}) as Record<string, string>;
      for (const [key, value] of Object.entries(envVars)) {
        envParts.push(`-e ${key}=${value}`);
      }
      envParts.push(`-e NODE_ENV=production`);
      envParts.push(`-e PORT=${containerPort}`);

      const labelParts: string[] = [];
      labelParts.push(`--label commitbase_app_id=${application.id}`);
      labelParts.push(`--label commitbase_app_domain=${application.domain}`);
      if (application.activeReleaseId) {
        labelParts.push(`--label commitbase_release_id=${application.activeReleaseId}`);
      }

      const resourceFlags = this.getDockerResourceFlags(application).join(' ');
      const runCommand = `docker run -d --name ${containerName} -p ${hostPort}:${containerPort} ${resourceFlags} ${labelParts.join(' ')} ${envParts.join(' ')} ${imageName}`;

      const { stdout, stderr } = await execAsync(runCommand, {
        timeout: 600000,
      });

      const completionTimestamp = new Date().toISOString();
      const deployLogEntry = `[${completionTimestamp}] DEPLOYMENT COMPLETED:\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}\n\n`;
      await fs.appendFile(deployLogPath, deployLogEntry);

      const status = await this.getDockerApplicationStatus(containerName);
      return status === 'RUNNING';
    } catch (error) {
      const appDir = path.join(this.baseDir, domain);
      const logsDir = path.join(appDir, 'logs');
      const deployLogPath = path.join(logsDir, 'deploy.log');
      const errorTimestamp = new Date().toISOString();
      const message = (error as any).stderr || (error as any).message || String(error);
      const errorLogEntry = `[${errorTimestamp}] DEPLOYMENT FAILED:\n${message}\n\n`;
      await fs.appendFile(deployLogPath, errorLogEntry);

      return false;
    }
  }

  async startRelease(application: Application, release: Release): Promise<boolean> {
    try {
      if (!application.domain) {
        throw new Error('Application domain is required for release start');
      }

      const domain = application.domain;
      const appDir = this.getAppDir(application.id);
      const logsDir = path.join(appDir, 'logs');
      const deployLogPath = path.join(logsDir, 'deploy.log');

      await fs.mkdir(logsDir, { recursive: true });

      const startTimestamp = new Date().toISOString();
      await fs.appendFile(deployLogPath, `[${startTimestamp}] RELEASE STARTED: ${release.id}\n`);

      const containerName = domain;

      try {
        await execAsync(`docker stop ${containerName} || true`);
        await execAsync(`docker rm ${containerName} || true`);
      } catch (error) {
      }

      const requestedPort = application.port || this.getDefaultPort(application.type);
      const hostPort = await this.findAvailablePort(requestedPort);

      if (hostPort !== requestedPort) {
        await prisma.application.update({
          where: { id: application.id },
          data: { port: hostPort },
        });
        (application as any).port = hostPort;
      }

      const containerPort = requestedPort;

      const envParts: string[] = [];
      const envVars = (application.envVars || {}) as Record<string, string>;
      for (const [key, value] of Object.entries(envVars)) {
        envParts.push(`-e ${key}=${value}`);
      }
      envParts.push(`-e NODE_ENV=production`);
      envParts.push(`-e PORT=${containerPort}`);

      const labelParts: string[] = [];
      labelParts.push(`--label commitbase_app_id=${application.id}`);
      labelParts.push(`--label commitbase_app_domain=${application.domain}`);
      labelParts.push(`--label commitbase_release_id=${release.id}`);

      const resourceFlags = this.getDockerResourceFlags(application).join(' ');
      const imageName = release.imageTag;
      const runCommand = `docker run -d --name ${containerName} -p ${hostPort}:${containerPort} ${resourceFlags} ${labelParts.join(' ')} ${envParts.join(' ')} ${imageName}`;

      const { stdout, stderr } = await execAsync(runCommand, {
        timeout: 600000,
      });

      const completionTimestamp = new Date().toISOString();
      const deployLogEntry = `[${completionTimestamp}] RELEASE COMPLETED:\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}\n\n`;
      await fs.appendFile(deployLogPath, deployLogEntry);

      const status = await this.getDockerApplicationStatus(containerName);
      return status === 'RUNNING';
    } catch (error) {
      const domain = application.domain;
      const appDir = this.getAppDir(application.id);
      const logsDir = path.join(appDir, 'logs');
      const deployLogPath = path.join(logsDir, 'deploy.log');
      const errorTimestamp = new Date().toISOString();
      const message = (error as any).stderr || (error as any).message || String(error);
      const errorLogEntry = `[${errorTimestamp}] RELEASE FAILED:\n${message}\n\n`;
      await fs.appendFile(deployLogPath, errorLogEntry);

      return false;
    }
  }

  /**
   * Stop Docker Compose for an application
   */
  async stopDockerCompose(domain: string): Promise<boolean> {
    try {
      const containerName = domain;
      await execAsync(`docker stop ${containerName}`);
      await execAsync(`docker rm ${containerName}`);
      return true;
    } catch (error: any) {
      if (error.stderr && error.stderr.includes('No such container')) {
        return true;
      }

      return false;
    }
  }

  /**
   * Restart Docker Compose for an application
   */
  async restartDockerCompose(domain: string): Promise<boolean> {
    try {
      await this.stopDockerCompose(domain);
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
      return await this.startDockerCompose(domain);
    } catch (error) {
      console.error(`Failed to restart Docker Compose for ${domain}:`, error);
      return false;
    }
  }

  /**
   * Get Docker Compose status for an application
   */
  async getDockerComposeStatus(domain: string): Promise<'RUNNING' | 'STOPPED' | 'ERROR'> {
    return this.getDockerApplicationStatus(domain);
  }

  /**
   * Get Docker Compose logs for an application
   */
  async getDockerComposeLogs(domain: string, service?: string, lines: number = 100): Promise<string> {
    return this.getApplicationLogs(domain, lines);
  }

  /**
   * Restart the application using Docker
   */
  async restartApplication(containerName?: string): Promise<boolean> {
    try {
      if (containerName) {
        await execAsync(`docker restart ${containerName}`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to restart Docker application:', error);
      return false;
    }
  }

  /**
   * Get application logs from Docker container
   */
  async getApplicationLogs(containerName: string, lines: number = 100): Promise<string> {
    try {
      const { stdout } = await execAsync(`docker logs --tail ${lines} ${containerName}`);
      return stdout;
    } catch (error) {
      return `Failed to get logs: ${error}`;
    }
  }

  /**
   * Get application status from Docker
   */
  async getDockerApplicationStatus(containerName: string): Promise<'RUNNING' | 'STOPPED' | 'ERROR'> {
    try {
      const { stdout } = await execAsync(`docker ps --filter "name=${containerName}" --format "{{.Status}}"`);
      if (stdout.includes('Up')) {
        return 'RUNNING';
      } else if (stdout.includes('Exited')) {
        return 'STOPPED';
      } else {
        return 'ERROR';
      }
    } catch {
      return 'ERROR';
    }
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
        const buildCommand = application.buildCommand || 'npm run build';

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

          await uploadDirectoryToS3(distDir, application.id);

          await uploadBuildLog(buildLogPath, application.id, deployment.id).catch(() => {});

          const buildLogs = await fs.readFile(buildLogPath, 'utf-8').catch(() => 'Build logs not available');

          await prisma.deployment.update({
            where: { id: deployment.id },
            data: {
              status: 'SUCCESS',
              buildLogs,
              deployLogs: 'Static site deployed to object storage',
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
            await configureCaddyForStaticApplication(application.id, application.domain);
          } catch {
          }

          return {
            success: true,
            buildLogs,
            deployLogs: 'Static site deployed to object storage',
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

      const buildResult = await this.runDockerCompose(appDir, application, deployment);

      // Get build logs
      let buildLogs = '';
      try {
        const logsDir = path.join(appDir, 'logs');
        const buildLogPath = path.join(logsDir, 'build.log');
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
          error: buildResult.error || 'Docker build failed',
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

      const startResult = await this.startDockerCompose(application.domain);

      let deployLogs = '';
      try {
        const logsDir = path.join(appDir, 'logs');
        const deployLogPath = path.join(logsDir, 'deploy.log');
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
          error: 'Application failed to start with Docker Compose',
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

      const imageTag = this.getImageName(application, deployment);
      const containerName = application.domain;
      const containerId = await this.getDockerContainerId(containerName);
      const hostPort = application.port || this.getDefaultPort(application.type);
      const containerPort = this.getDefaultPort(application.type);
      const logsRef = logsDir;

      const release = await prisma.release.create({
        data: {
          applicationId: application.id,
          imageTag,
          commitSha: commitSha ?? null,
          status: 'READY',
          containerId: containerId ?? null,
          ports: {
            hostPort,
            containerPort,
          },
          health: 'UNKNOWN',
          logsRef,
        },
      });

      await prisma.application.update({
        where: { id: application.id },
        data: { activeReleaseId: release.id },
      });

      try {
        await configureCaddyForRuntimeApplication(application.domain, hostPort);
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

  private async enforceImageRetentionPolicy(application: Application, retentionCount: number = 10): Promise<void> {
    try {
      const repository = `app-${application.id.toLowerCase()}`;
      const { stdout } = await execAsync(`docker images ${repository} --format "{{.Repository}}:{{.Tag}}|{{.CreatedAt}}"`);
      const lines = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);

      if (lines.length <= retentionCount) {
        return;
      }

      const images = lines.map(line => {
        const [ref, createdAt] = line.split('|');
        return {
          ref,
          createdAt: createdAt ? new Date(createdAt) : new Date(0),
        };
      });

      images.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      const toDelete = images.slice(retentionCount);

      for (const image of toDelete) {
        if (!image.ref) {
          continue;
        }
        try {
          await execAsync(`docker rmi ${image.ref}`);
        } catch {
        }
      }
    } catch (error) {
      console.error('Failed to enforce image retention policy:', error);
    }
  }

  /**
   * Get application status using Docker Compose
   */
  async getApplicationStatus(domain: string): Promise<'RUNNING' | 'STOPPED' | 'ERROR'> {
    try {
      if (!domain) {
        return 'ERROR';
      }

      return await this.getDockerApplicationStatus(domain);
    } catch (error) {
      return 'ERROR';
    }
  }

  /**
   * List all Docker containers
   */
  async listDockerContainers(): Promise<any[]> {
    try {
      const { stdout } = await execAsync('docker ps -a --format json');
      return stdout.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    } catch (error) {
      console.error('Failed to list Docker containers:', error);
      return [];
    }
  }

  /**
   * Clean up Docker containers for an application
   */
  async cleanupDockerContainers(domain: string): Promise<void> {
    try {
      const containerName = this.generateContainerName(domain);
      await execAsync(`docker stop ${containerName} || true`);
      await execAsync(`docker rm ${containerName} || true`);
    } catch (error) {
      console.error('Failed to cleanup Docker containers:', error);
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

      const appDir = this.getAppDir(deployment.applicationId);
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

      const appDir = this.getAppDir(deployment.applicationId);
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

      const appDir = this.getAppDir(domain);
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

      const appDir = this.getAppDir(domain);
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

      const appDir = this.getAppDir(domain);
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

  /**
   * Get available Docker templates
   */
  async getAvailableTemplates(): Promise<string[]> {
    return await this.templateEngine.getAvailableTemplates();
  }

  /**
   * Get template content
   */
  async getTemplateContent(templateName: string): Promise<string> {
    try {
      const templatePath = path.join(process.cwd(), 'src', 'templates', 'dockerfiles', `${templateName}.Dockerfile`);
      return await fs.readFile(templatePath, 'utf-8');
    } catch (error) {
      throw new Error(`Template ${templateName} not found`);
    }
  }

  /**
   * Update template content
   */
  async updateTemplateContent(templateName: string, content: string): Promise<void> {
    try {
      const templatePath = path.join(process.cwd(), 'src', 'templates', 'dockerfiles', `${templateName}.Dockerfile`);
      await fs.writeFile(templatePath, content);
    } catch (error) {
      throw new Error(`Failed to update template ${templateName}`);
    }
  }

  /**
   * Create new template
   */
  async createTemplate(templateName: string, content: string): Promise<void> {
    try {
      const templatePath = path.join(process.cwd(), 'src', 'templates', 'dockerfiles', `${templateName}.Dockerfile`);
      await fs.writeFile(templatePath, content);
    } catch (error) {
      throw new Error(`Failed to create template ${templateName}`);
    }
  }

  /**
   * Delete template
   */
  async deleteTemplate(templateName: string): Promise<void> {
    try {
      const templatePath = path.join(process.cwd(), 'src', 'templates', 'dockerfiles', `${templateName}.Dockerfile`);
      await fs.unlink(templatePath);
    } catch (error) {
      throw new Error(`Failed to delete template ${templateName}`);
    }
  }
}
