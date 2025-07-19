import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Application, Deployment } from '@prisma/client';
import { prisma } from '../lib/prisma';
import * as crypto from 'crypto';
import { TemplateEngine, TemplateData } from '../utils/templateEngine';

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
  return application.domain.replace(/[^a-zA-Z0-9]/g, '_');
}

export class DeploymentService {
  private baseDir: string;
  private templateEngine: TemplateEngine;

  constructor() {
    this.baseDir = process.env.APPS_DIR || path.join(process.cwd(), 'apps_dir');
    this.templateEngine = new TemplateEngine();
  }

  /**
   * Prepare the application directory using subdomain.domain.tld format
   */
  async prepareAppDirectory(domain: string): Promise<string> {
    const appDir = path.join(this.baseDir, domain);

    try {
      // Create apps_dir directory if it doesn't exist
      await fs.mkdir(this.baseDir, { recursive: true });

      // Create app directory if it doesn't exist
      await fs.mkdir(appDir, { recursive: true });

      // Create logs directory
      const logsDir = path.join(appDir, 'logs');
      await fs.mkdir(logsDir, { recursive: true });

      // Create sources directory
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
   * Create Docker Compose file for the application with persistent volumes
   */
  async createDockerCompose(appDir: string, application: Application): Promise<string> {
    const sourcesDir = path.join(appDir, 'sources');
    const composePath = path.join(sourcesDir, 'docker-compose.yml');

    // Generate unique names for volumes and networks
    const containerName = getDockerContainerName(application);
    const networkName = `${containerName}_network`;

    // Find available port
    const requestedPort = application.port || this.getDefaultPort(application.type);
    console.log(`Requested port for ${application.name}: ${requestedPort}`);
    
    // Debug: Show currently used ports
    const usedPorts = await this.getUsedPorts();
    console.log(`Currently used ports: ${usedPorts.join(', ')}`);
    
    const availablePort = await this.findAvailablePort(requestedPort);
    console.log(`Allocated port for ${application.name}: ${availablePort}`);

    // Update application with allocated port if different from requested
    if (availablePort !== requestedPort) {
      await prisma.application.update({
        where: { id: application.id },
        data: { port: availablePort }
      });
      console.log(`Updated application ${application.name} port from ${requestedPort} to ${availablePort}`);
    }

    // Prepare template data for Docker Compose
    const templateData: TemplateData = {
      containerName: containerName,
      startCommand: application.startCommand,
      domain: application.domain,
      hostPort: availablePort,
      containerPort: requestedPort, // Keep container port as requested
      appVolume: `${containerName}_app`,
      networkName: networkName,
      nodeEnv: 'production',
      environmentVariables: this.formatEnvironmentVariables(application.envVars as Record<string, string> || {}),
      resourceLimits: this.getResourceLimits(application)
    };

    // Render Docker Compose template using template engine
    const composeContent = await this.templateEngine.renderTemplate('docker-compose', templateData, 'compose');
    console.log('composeContent', composeContent);
    console.log('composePath', composePath);
    // Debug: Log the generated content
    console.log('Generated Docker Compose content:', composeContent);
    console.log('Template data used:', templateData);

    // Write Docker Compose file
    await fs.writeFile(composePath, composeContent);
    console.log(`Docker Compose file written to: ${composePath}`);

    // Clean up any containers that might be using the allocated port
    try {
      const { stdout } = await execAsync(`docker ps --format "table {{.Names}}\t{{.Ports}}" | grep ":${templateData.hostPort}->"`);
      if (stdout.trim()) {
        console.log(`Found containers using port ${templateData.hostPort}, stopping them...`);
        const containerNames = stdout.split('\n').map(line => line.split('\t')[0]).filter(name => name && name.trim());
        for (const containerName of containerNames) {
          try {
            await execAsync(`docker stop ${containerName}`);
            await execAsync(`docker rm ${containerName}`);
            console.log(`Stopped and removed container: ${containerName}`);
          } catch (error) {
            console.log(`Failed to stop container ${containerName}:`, error);
          }
        }
      }
    } catch (error) {
      // No containers found using the port
      console.log(`No containers found using port ${templateData.hostPort}`);
    }

    return composePath;
  }

  /**
   * Get currently used ports for debugging
   */
  private async getUsedPorts(): Promise<number[]> {
    try {
      const { stdout } = await execAsync(`docker ps --format "table {{.Ports}}" | grep -o ":[0-9]*->" | grep -o "[0-9]*"`);
      return stdout.split('\n').filter(port => port.trim()).map(port => parseInt(port));
    } catch (error) {
      return [];
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
    // if (!application.memory && !application.cpu) {
    //   return '';
    // }

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
  async runDockerCompose(appDir: string, application: Application): Promise<BuildResult> {
    try {
      console.log(`Running Docker Compose for application: ${application.name}`);
      console.log('appDir', appDir);
      const sourcesDir = path.join(appDir, 'sources');
      const logsDir = path.join(appDir, 'logs');
      console.log('sourcesDir', sourcesDir);
      console.log('logsDir', logsDir);
      // Ensure logs directory exists
      await fs.mkdir(logsDir, { recursive: true });
      await this.createDockerCompose(appDir, application);
      const buildLogPath = path.join(logsDir, 'build.log');
      const timestamp = new Date().toISOString();

      // Clear and write build start to log
      await fs.writeFile(buildLogPath, `[${timestamp}] DOCKER COMPOSE STARTED\n`);

      // Create Dockerfile
      console.log('Creating Dockerfile');
      await this.createDockerfile(appDir, application);

      // Create .dockerignore
      console.log('Creating .dockerignore');
      await this.createDockerignore(appDir);

      // Stop and remove existing containers first
      console.log('Stopping and removing existing containers');
      try {
        await execAsync(`docker compose down --remove-orphans`, {
          cwd: sourcesDir,
          timeout: 60000, // 1 minute timeout
        });
      } catch (error) {
        console.log('No existing containers to remove or error during cleanup:', error);
      }

      // Run Docker Compose
      console.log('Running Docker Compose');
      const { stdout, stderr } = await execAsync(`docker compose up -d --build`, {
        cwd: sourcesDir,
        timeout: 600000, // 10 minutes timeout
      });

      // Clean up unused images
      console.log('Cleaning up unused images');
      try {
        await execAsync(`docker image prune -a -f`);
      } catch (error) {
        console.log('Error during image cleanup:', error);
      }
      // Log build completion
      const completionTimestamp = new Date().toISOString();
      const buildLogEntry = `[${completionTimestamp}] DOCKER COMPOSE COMPLETED:\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}\n\n`;
      await fs.appendFile(buildLogPath, buildLogEntry);

      return {
        success: true,
      };
    } catch (error: any) {
      // Log build error
      const logsDir = path.join(appDir, 'logs');
      const buildLogPath = path.join(logsDir, 'build.log');
      const errorTimestamp = new Date().toISOString();
      const errorLogEntry = `[${errorTimestamp}] DOCKER COMPOSE FAILED:\n${error.stderr || error.message}\n\n`;
      console.log('errorLogEntry', errorLogEntry); console.log('errorLogEntry', errorLogEntry);
      await fs.appendFile(buildLogPath, errorLogEntry);

      return {
        success: false,
        error: error.stderr || error.message,
      };
    }
  }

  /**
   * Start the application using Docker
   */
  async startApplication(appDir: string): Promise<StartResult> {
    try {
      console.log(`Starting application with Docker Compose`);

      const sourcesDir = path.join(appDir, 'sources');
      const containerName = this.generateContainerName(appDir);

      // Stop and remove existing container if it exists
      try {
        await execAsync(`docker stop ${containerName} || true`);
        await execAsync(`docker rm ${containerName} || true`);
      } catch (error) {
        // Container doesn't exist, which is fine
      }

      // Start Docker container
      const { stdout, stderr } = await execAsync(`docker-compose up -d`, {
        cwd: sourcesDir,
        timeout: 600000, // 10 minutes timeout
      });

      // Wait a bit to see if the container starts successfully
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Check if container is running
      const isRunning = await this.checkDockerContainerRunning(containerName);

      if (isRunning) {
        const containerId = await this.getDockerContainerId(containerName);
        return {
          success: true,
          logs: `Application started successfully with Docker (${containerName})`,
          pid: undefined, // Docker doesn't use PIDs in the same way
        };
      } else {
        return {
          success: false,
          logs: '',
          error: 'Application failed to start with Docker',
        };
      }
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
      const appDir = path.join(this.baseDir, domain);
      const sourcesDir = path.join(appDir, 'sources');
      const composePath = path.join(sourcesDir, 'docker-compose.yml');
      const logsDir = path.join(appDir, 'logs');
      const deployLogPath = path.join(logsDir, 'deploy.log');

      // Check if docker-compose.yml exists
      const exists = await fs.access(composePath).then(() => true).catch(() => false);
      if (!exists) {
        throw new Error('Docker Compose file not found');
      }

      // Ensure logs directory exists
      await fs.mkdir(logsDir, { recursive: true });

      // Log deployment start
      const startTimestamp = new Date().toISOString();
      await fs.appendFile(deployLogPath, `[${startTimestamp}] DEPLOYMENT STARTED\n`);

      // Stop and remove existing containers first
      console.log(`Stopping existing containers for ${domain}`);
      try {
        await execAsync('docker-compose down --remove-orphans', {
          cwd: sourcesDir,
          timeout: 60000, // 1 minute timeout
        });
        await fs.appendFile(deployLogPath, `[${new Date().toISOString()}] Stopped existing containers\n`);
      } catch (error) {
        console.log(`No existing containers to remove for ${domain} or error during cleanup:`, error);
        await fs.appendFile(deployLogPath, `[${new Date().toISOString()}] No existing containers to remove\n`);
      }

      // Start containers with Docker Compose
      const { stdout, stderr } = await execAsync('docker-compose up -d', {
        cwd: sourcesDir,
        timeout: 120000, // 2 minutes timeout
      });

      // Log deployment completion
      const completionTimestamp = new Date().toISOString();
      const deployLogEntry = `[${completionTimestamp}] DEPLOYMENT COMPLETED:\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}\n\n`;
      await fs.appendFile(deployLogPath, deployLogEntry);

      console.log(`Docker Compose started for ${domain}:`, stdout);
      return true;
    } catch (error) {
      // Log deployment error
      const appDir = path.join(this.baseDir, domain);
      const logsDir = path.join(appDir, 'logs');
      const deployLogPath = path.join(logsDir, 'deploy.log');
      const errorTimestamp = new Date().toISOString();
      const errorLogEntry = `[${errorTimestamp}] DEPLOYMENT FAILED:\n${error}\n\n`;
      await fs.appendFile(deployLogPath, errorLogEntry);

      console.error(`Failed to start Docker Compose for ${domain}:`, error);
      return false;
    }
  }

  /**
   * Stop Docker Compose for an application
   */
  async stopDockerCompose(domain: string): Promise<boolean> {
    try {
      const appDir = path.join(this.baseDir, domain);
      const sourcesDir = path.join(appDir, 'sources');
      const composePath = path.join(sourcesDir, 'docker-compose.yml');

      // Check if docker-compose.yml exists
      const exists = await fs.access(composePath).then(() => true).catch(() => false);
      if (!exists) {
        return true; // No compose file, nothing to stop
      }

      // Stop containers with Docker Compose
      const { stdout, stderr } = await execAsync('docker-compose down', {
        cwd: sourcesDir,
        timeout: 60000, // 1 minute timeout
      });

      console.log(`Docker Compose stopped for ${domain}:`, stdout);
      return true;
    } catch (error: any) {
      // If container doesn't exist, consider it a success
      if (error.stderr && error.stderr.includes('No such container')) {
        console.log(`Container for ${domain} doesn't exist, considering stop successful`);
        return true;
      }

      console.error(`Failed to stop Docker Compose for ${domain}:`, error);
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
    try {
      const appDir = path.join(this.baseDir, domain);
      const sourcesDir = path.join(appDir, 'sources');
      const composePath = path.join(sourcesDir, 'docker-compose.yml');

      // Check if docker-compose.yml exists
      const exists = await fs.access(composePath).then(() => true).catch(() => false);
      if (!exists) {
        return 'STOPPED';
      }

      // Check Docker Compose status
      const { stdout } = await execAsync('docker-compose ps', {
        cwd: sourcesDir,
        timeout: 30000, // 30 seconds timeout
      });

      if (stdout.includes('Up')) {
        return 'RUNNING';
      } else if (stdout.includes('Exit')) {
        return 'ERROR';
      } else {
        return 'STOPPED';
      }
    } catch (error) {
      console.error(`Failed to get Docker Compose status for ${domain}:`, error);
      return 'ERROR';
    }
  }

  /**
   * Get Docker Compose logs for an application
   */
  async getDockerComposeLogs(domain: string, service?: string, lines: number = 100): Promise<string> {
    try {
      const appDir = path.join(this.baseDir, domain);
      const sourcesDir = path.join(appDir, 'sources');
      const composePath = path.join(sourcesDir, 'docker-compose.yml');

      // Check if docker-compose.yml exists
      const exists = await fs.access(composePath).then(() => true).catch(() => false);
      if (!exists) {
        return 'Docker Compose file not found';
      }

      // Get logs from Docker Compose
      const serviceArg = service ? ` ${service}` : '';
      const { stdout, stderr } = await execAsync(`docker-compose logs --tail=${lines}${serviceArg}`, {
        cwd: sourcesDir,
        timeout: 30000, // 30 seconds timeout
      });

      return stdout || stderr || 'No logs available';
    } catch (error) {
      return `Failed to get Docker Compose logs: ${error}`;
    }
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

    try {
      console.log(`Starting deployment for application: ${application.name}`);

      // Update deployment status to BUILDING
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: { status: 'BUILDING' },
      });

      // 1. Prepare app directory using domain
      if (!application.domain) {
        throw new Error('Application domain is required');
      }
      const appDir = await this.prepareAppDirectory(application.domain);

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

      // 2. Sync repository
      if (application.repository) {
        const branch = application.branch || 'main';
        await this.syncRepository(appDir, application.repository, branch);
      }

      // 3. Create Docker Compose file with persistent volumes
      // 4. Build Docker image
      const buildResult = await this.runDockerCompose(appDir, application);

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

      // Update deployment status to DEPLOYING
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: { 
          status: 'DEPLOYING',
          buildLogs,
        },
      });

      // 5. Start application with Docker Compose
      const startResult = await this.startDockerCompose(application.domain);

      // Get deploy logs
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
        // Update deployment with failure
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

      // Update deployment with success
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: { 
          status: 'SUCCESS',
          buildLogs,
          deployLogs,
        },
      });

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
   * Get application status using Docker Compose
   */
  async getApplicationStatus(domain: string): Promise<'RUNNING' | 'STOPPED' | 'ERROR'> {
    try {
      if (!domain) {
        return 'ERROR';
      }

      // Check if app directory exists
      const appDir = path.join(this.baseDir, domain);
      const exists = await fs.access(appDir).then(() => true).catch(() => false);

      if (!exists) {
        return 'STOPPED';
      }

      // Check Docker Compose status
      return await this.getDockerComposeStatus(domain);
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

      const appDir = path.join(this.baseDir, deployment.application.domain);
      const logsDir = path.join(appDir, 'logs');
      const buildLogPath = path.join(logsDir, 'build.log');
      const deployLogPath = path.join(logsDir, 'deploy.log');

      // Clear both build and deploy logs
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

      const appDir = path.join(this.baseDir, deployment.application.domain);
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

      const appDir = path.join(this.baseDir, domain);
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

      const appDir = path.join(this.baseDir, domain);
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

      const appDir = path.join(this.baseDir, domain);
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