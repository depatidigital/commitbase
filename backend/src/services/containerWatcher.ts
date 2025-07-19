import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaClient, Application } from '@prisma/client';

const execAsync = promisify(exec);

export class ContainerWatcher {
  private prisma: PrismaClient;
  private baseDir: string;
  private isWatching: boolean = false;
  private watchInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.prisma = new PrismaClient();
    this.baseDir = process.env.APPS_DIR || path.join(process.cwd(), 'apps_dir');
  }

  /**
   * Start watching containers
   */
  async startWatching(): Promise<void> {
    if (this.isWatching) {
      return;
    }

    this.isWatching = true;
    console.log('Starting container watcher...');

    // Check containers every 30 seconds
    this.watchInterval = setInterval(async () => {
      try {
        await this.checkAllContainers();
      } catch (error) {
        console.error('Container watcher error:', error);
      }
    }, 30000);

    // Initial check
    await this.checkAllContainers();
  }

  /**
   * Stop watching containers
   */
  stopWatching(): void {
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }
    this.isWatching = false;
    console.log('Container watcher stopped');
  }

  /**
   * Check all running applications and update their status
   */
  async checkAllContainers(): Promise<void> {
    try {
      // Get all applications that should be running
      const applications = await this.prisma.application.findMany({
        where: {
          status: 'RUNNING'
        }
      });

      console.log(`Checking ${applications.length} running applications...`);

      for (const application of applications) {
        await this.checkContainerStatus(application);
      }
    } catch (error) {
      console.error('Error checking containers:', error);
    }
  }

  /**
   * Check status of a specific container
   */
  async checkContainerStatus(application: Application): Promise<void> {
    try {
      const containerName = application.domain;
      
      // Check if container exists and is running
      const { stdout } = await execAsync(`docker ps --filter "name=${containerName}" --format "{{.Names}}\t{{.Status}}"`);
      
      if (!stdout.trim()) {
        // Container doesn't exist or is not running
        console.log(`Container ${containerName} is not running, updating status to STOPPED`);
        await this.updateApplicationStatus(application.id, 'STOPPED');
        return;
      }

      // Check if container is actually running (not just exists)
      if (stdout.includes('Up')) {
        // Container is running, status is already RUNNING
        return;
      } else {
        // Container exists but is not running (exited, etc.)
        console.log(`Container ${containerName} is not running (exited), updating status to STOPPED`);
        await this.updateApplicationStatus(application.id, 'STOPPED');
      }
    } catch (error) {
      // If docker command fails, assume container doesn't exist
      console.log(`Container ${application.domain} not found, updating status to STOPPED`);
      await this.updateApplicationStatus(application.id, 'STOPPED');
    }
  }

  /**
   * Update application status in database
   */
  async updateApplicationStatus(applicationId: string, status: 'RUNNING' | 'STOPPED' | 'ERROR'): Promise<void> {
    try {
      await this.prisma.application.update({
        where: { id: applicationId },
        data: { 
          status,
          updatedAt: new Date()
        }
      });
      console.log(`Updated application ${applicationId} status to ${status}`);
    } catch (error) {
      console.error(`Failed to update application ${applicationId} status:`, error);
    }
  }

  /**
   * Check if a specific container is running
   */
  async isContainerRunning(containerName: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`docker ps --filter "name=${containerName}" --format "{{.Names}}"`);
      return stdout.trim() !== '';
    } catch (error) {
      return false;
    }
  }

  /**
   * Get container status for a specific application
   */
  async getContainerStatus(containerName: string): Promise<'RUNNING' | 'STOPPED' | 'ERROR'> {
    try {
      const { stdout } = await execAsync(`docker ps --filter "name=${containerName}" --format "{{.Names}}\t{{.Status}}"`);
      
      if (!stdout.trim()) {
        return 'STOPPED';
      }

      if (stdout.includes('Up')) {
        return 'RUNNING';
      } else {
        return 'STOPPED';
      }
    } catch (error) {
      return 'STOPPED';
    }
  }

  /**
   * Restart a stopped container
   */
  async restartContainer(application: Application): Promise<boolean> {
    try {
      const appDir = path.join(this.baseDir, application.domain);
      const sourcesDir = path.join(appDir, 'sources');
      const composePath = path.join(sourcesDir, 'docker-compose.yml');
      
      // Check if docker-compose.yml exists
      const exists = await fs.access(composePath).then(() => true).catch(() => false);
      if (!exists) {
        console.log(`No docker-compose.yml found for ${application.domain}`);
        return false;
      }
      
      // Restart using docker-compose
      const { stdout, stderr } = await execAsync('docker-compose up -d', {
        cwd: sourcesDir,
        timeout: 60000, // 1 minute timeout
      });
      
      console.log(`Restarted container for ${application.domain}:`, stdout);
      
      // Update status to RUNNING
      await this.updateApplicationStatus(application.id, 'RUNNING');
      
      return true;
    } catch (error) {
      console.error(`Failed to restart container for ${application.domain}:`, error);
      await this.updateApplicationStatus(application.id, 'ERROR');
      return false;
    }
  }

  /**
   * Clean up stopped containers
   */
  async cleanupStoppedContainers(): Promise<void> {
    try {
      const { stdout } = await execAsync('docker container prune -f');
      console.log('Cleaned up stopped containers:', stdout);
    } catch (error) {
      console.error('Failed to cleanup stopped containers:', error);
    }
  }

  /**
   * Get watcher status
   */
  getWatcherStatus(): { isWatching: boolean; lastCheck?: Date } {
    return {
      isWatching: this.isWatching,
      lastCheck: this.lastCheckTime
    };
  }

  private lastCheckTime: Date = new Date();

  /**
   * Update last check time
   */
  private updateLastCheckTime(): void {
    this.lastCheckTime = new Date();
  }
} 