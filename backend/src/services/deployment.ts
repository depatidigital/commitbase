import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Application, Deployment } from '@prisma/client';

const execAsync = promisify(exec);

export interface DeploymentConfig {
  application: Application;
  deployment: Deployment;
  envVars?: Record<string, string>;
}

export interface BuildResult {
  success: boolean;
  logs: string;
  error?: string;
}

export interface StartResult {
  success: boolean;
  logs: string;
  error?: string;
  pid?: number | undefined;
}

export class DeploymentService {
  private baseDir: string;

  constructor() {
    this.baseDir = process.env.APPS_DIR || path.join(process.cwd(), 'apps_dir');
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
   * Run build command in sources directory
   */
  async runBuildCommand(appDir: string, buildCommand: string, envVars: Record<string, string> = {}): Promise<BuildResult> {
    try {
      console.log(`Running build command: ${buildCommand}`);
      
      const sourcesDir = path.join(appDir, 'sources');
      const logsDir = path.join(appDir, 'logs');
      
      const env = { ...process.env, ...envVars };
      const { stdout, stderr } = await execAsync(buildCommand, {
        cwd: sourcesDir,
        env,
        timeout: 300000, // 5 minutes timeout
      });

      // Save build logs to file
      const buildLogPath = path.join(logsDir, 'build.log');
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] BUILD LOG:\n${stdout}\n${stderr}\n\n`;
      await fs.appendFile(buildLogPath, logEntry);

      return {
        success: true,
        logs: stdout,
      };
    } catch (error: any) {
      // Save build error logs to file
      const logsDir = path.join(appDir, 'logs');
      const buildLogPath = path.join(logsDir, 'build.log');
      const timestamp = new Date().toISOString();
      const errorLogEntry = `[${timestamp}] BUILD ERROR:\n${error.stderr || error.message}\n\n`;
      await fs.appendFile(buildLogPath, errorLogEntry);

      return {
        success: false,
        logs: error.stdout || '',
        error: error.stderr || error.message,
      };
    }
  }

  /**
   * Start the application using PM2
   */
  async startApplication(appDir: string, startCommand: string, port: number, envVars: Record<string, string> = {}): Promise<StartResult> {
    try {
      console.log(`Starting application with PM2: ${startCommand} on port ${port}`);
      
      const sourcesDir = path.join(appDir, 'sources');
      const logsDir = path.join(appDir, 'logs');
      
      // Create app name from domain
      const domain = path.basename(appDir);
      const appName = `app-${domain.replace(/[^a-zA-Z0-9]/g, '-')}`;
      
      // Create logs directory
      await fs.mkdir(logsDir, { recursive: true });
      
      const env = { 
        ...process.env, 
        ...envVars,
        PORT: port.toString(),
        NODE_ENV: 'production',
      };

      // Create PM2 ecosystem file
      const ecosystemPath = path.join(appDir, 'ecosystem.config.js');
      const ecosystemContent = `module.exports = {
  apps: [{
    name: '${appName}',
    script: '${startCommand}',
    cwd: '${sourcesDir}',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: '${port}',
      ${Object.entries(envVars).map(([key, value]) => `${key}: '${value}'`).join(',\n      ')}
    },
    log_file: '${path.join(logsDir, 'combined.log')}',
    out_file: '${path.join(logsDir, 'out.log')}',
    error_file: '${path.join(logsDir, 'error.log')}',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    time: true
  }]
};`;

      await fs.writeFile(ecosystemPath, ecosystemContent);

      // Start application with PM2
      const { stdout } = await execAsync(`cd "${appDir}" && pm2 start ecosystem.config.js --no-daemon`);
      
      // Wait a bit to see if the process starts successfully
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Check if PM2 process is running
      const isRunning = await this.checkPM2ProcessRunning(appName);

      if (isRunning) {
        const pid = await this.getPM2ProcessId(appName);
        return {
          success: true,
          logs: `Application started successfully with PM2 (${appName})`,
          pid: pid || undefined,
        };
      } else {
        return {
          success: false,
          logs: '',
          error: 'Application failed to start with PM2',
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
   * Stop the application using PM2
   */
  async stopApplication(appName?: string): Promise<boolean> {
    try {
      if (appName) {
        await execAsync(`pm2 stop ${appName}`);
        await execAsync(`pm2 delete ${appName}`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to stop PM2 application:', error);
      return false;
    }
  }

  /**
   * Restart the application using PM2
   */
  async restartApplication(appName?: string): Promise<boolean> {
    try {
      if (appName) {
        await execAsync(`pm2 restart ${appName}`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to restart PM2 application:', error);
      return false;
    }
  }

  /**
   * Check if PM2 process is running
   */
  private async checkPM2ProcessRunning(appName: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`pm2 list | grep ${appName}`);
      return stdout.includes('online');
    } catch {
      return false;
    }
  }

  /**
   * Get PM2 process ID
   */
  private async getPM2ProcessId(appName: string): Promise<number | undefined> {
    try {
      const { stdout } = await execAsync(`pm2 list | grep ${appName}`);
      const match = stdout.match(/(\d+)/);
      return match ? parseInt(match[1]) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Get application logs from PM2
   */
  async getApplicationLogs(appName: string, lines: number = 100): Promise<string> {
    try {
      const { stdout } = await execAsync(`pm2 logs ${appName} --lines ${lines} --nostream`);
      return stdout;
    } catch (error) {
      return `Failed to get logs: ${error}`;
    }
  }

  /**
   * Get application status from PM2
   */
  async getPM2ApplicationStatus(appName: string): Promise<'RUNNING' | 'STOPPED' | 'ERROR'> {
    try {
      const { stdout } = await execAsync(`pm2 list | grep ${appName}`);
      if (stdout.includes('online')) {
        return 'RUNNING';
      } else if (stdout.includes('stopped')) {
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
    buildLogs: string;
    startLogs: string;
    error?: string;
  }> {
    const { application, deployment, envVars = {} } = config;

    try {
      console.log(`Starting deployment for application: ${application.name}`);

      // 1. Prepare app directory using domain
      if (!application.domain) {
        throw new Error('Application domain is required');
      }
      const appDir = await this.prepareAppDirectory(application.domain);

      // 2. Sync repository
      if (application.repository) {
        const branch = application.branch || 'main';
        await this.syncRepository(appDir, application.repository, branch);
      }

      // 3. Install dependencies
      await this.installDependencies(appDir);

      // 4. Run build command
      let buildLogs = '';
      if (application.buildCommand) {
        const buildResult = await this.runBuildCommand(appDir, application.buildCommand, envVars);
        buildLogs = buildResult.logs;
        
        if (!buildResult.success) {
          return {
            success: false,
            buildLogs,
            startLogs: '',
            error: buildResult.error || 'Build failed',
          };
        }
      }

      // 5. Start application (only for Node.js apps)
      let startLogs = '';
      if (application.type === 'NODEJS' && application.startCommand && application.port) {
        const startResult = await this.startApplication(appDir, application.startCommand, application.port, envVars);
        startLogs = startResult.logs;
        
        if (!startResult.success) {
          return {
            success: false,
            buildLogs,
            startLogs,
            error: startResult.error || 'Application failed to start',
          };
        }
      }

      return {
        success: true,
        buildLogs,
        startLogs,
      };

    } catch (error: any) {
      return {
        success: false,
        buildLogs: '',
        startLogs: '',
        error: error.message,
      };
    }
  }

  /**
   * Get application status
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

      // Check PM2 status
      const appName = `app-${domain.replace(/[^a-zA-Z0-9]/g, '-')}`;
      return await this.getPM2ApplicationStatus(appName);
    } catch (error) {
      return 'ERROR';
    }
  }

  /**
   * List all PM2 processes
   */
  async listPM2Processes(): Promise<any[]> {
    try {
      const { stdout } = await execAsync('pm2 list --format json');
      return JSON.parse(stdout);
    } catch (error) {
      console.error('Failed to list PM2 processes:', error);
      return [];
    }
  }

  /**
   * Clean up PM2 processes for an application
   */
  async cleanupPM2Processes(domain: string): Promise<void> {
    try {
      const appName = `app-${domain.replace(/[^a-zA-Z0-9]/g, '-')}`;
      await execAsync(`pm2 delete ${appName} || true`);
    } catch (error) {
      console.error('Failed to cleanup PM2 processes:', error);
    }
  }

  /**
   * Get application logs from files
   */
  async getApplicationLogsFromFiles(domain: string, logType: string = 'combined', lines: number = 100): Promise<string> {
    try {
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

      const logContent = await fs.readFile(logFile, 'utf-8');
      const logLines = logContent.split('\n').slice(-lines).join('\n');
      return logLines;
    } catch (error) {
      return `No logs available for ${logType}`;
    }
  }
}