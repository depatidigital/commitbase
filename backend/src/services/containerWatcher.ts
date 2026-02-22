import { exec, spawn, ChildProcessWithoutNullStreams } from 'child_process';
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
  private eventsProcess: ChildProcessWithoutNullStreams | null = null;

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
    console.log('Starting container watcher (event-driven)...');

    this.watchInterval = setInterval(async () => {
      try {
        await this.checkAllContainers();
      } catch (error) {
        console.error('Container watcher error:', error);
      }
    }, 300000);

    await this.checkAllContainers();
    await this.startDockerEventsListener();
  }

  /**
   * Stop watching containers
   */
  stopWatching(): void {
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }
    if (this.eventsProcess) {
      this.eventsProcess.kill();
      this.eventsProcess = null;
    }
    this.isWatching = false;
    console.log('Container watcher stopped');
  }

  async startDockerEventsListener(): Promise<void> {
    try {
      if (this.eventsProcess) {
        return;
      }

      const args = [
        'events',
        '--format',
        '{{json .}}',
      ];

      const proc = spawn('docker', args);
      this.eventsProcess = proc;

      proc.stdout.on('data', async (data: Buffer) => {
        const text = data.toString().trim();
        if (!text) {
          return;
        }

        const lines = text.split('\n').filter(line => line.trim());
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            await this.handleDockerEvent(event);
          } catch {
          }
        }
      });

      proc.stderr.on('data', (data: Buffer) => {
        console.error('Docker events error:', data.toString());
      });

      proc.on('exit', (code, signal) => {
        console.log(`Docker events process exited with code ${code}, signal ${signal}`);
        this.eventsProcess = null;
        if (this.isWatching) {
          setTimeout(() => {
            this.startDockerEventsListener().catch(() => {});
          }, 5000);
        }
      });
    } catch (error) {
      console.error('Failed to start Docker events listener:', error);
    }
  }

  private async handleDockerEvent(event: any): Promise<void> {
    try {
      const status = event.status as string | undefined;
      const id = event.id as string | undefined;
      const attrs = event.Actor?.Attributes || {};
      const name = attrs.name as string | undefined;
      const appId = attrs.commitbase_app_id as string | undefined;
      const appDomain = attrs.commitbase_app_domain as string | undefined;
      const releaseId = attrs.commitbase_release_id as string | undefined;

      if (!status) {
        return;
      }

      let application: Application | null = null;

      if (appId) {
        application = await this.prisma.application.findUnique({
          where: { id: appId },
        });
      } else if (appDomain) {
        application = await this.prisma.application.findFirst({
          where: { domain: appDomain },
        });
      } else if (name) {
        application = await this.prisma.application.findFirst({
          where: { domain: name },
        });
      }

      if (!application) {
        return;
      }

      if (status === 'start') {
        await this.updateApplicationStatus(application.id, 'RUNNING');
        if (id) {
          await this.updateActiveReleaseContainer(application.id, id);
          if (releaseId) {
            await this.updateReleaseById(id, releaseId);
          }
        }
        return;
      }

      if (status === 'die' || status === 'stop') {
        await this.updateApplicationStatus(application.id, 'STOPPED');
        return;
      }

      if (status.startsWith('health_status:')) {
        const health = status.split(':')[1]?.trim() || '';
        if (releaseId) {
          await this.updateReleaseHealthById(releaseId, health);
        } else {
          await this.updateReleaseHealth(application.id, health);
        }
        if (health === 'healthy') {
          await this.updateApplicationStatus(application.id, 'RUNNING');
        }
        if (health === 'unhealthy') {
          await this.updateApplicationStatus(application.id, 'ERROR');
        }
        return;
      }
    } catch (error) {
      console.error('Error handling Docker event:', error);
    }
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
      const { stdout } = await execAsync(`docker ps --filter "name=${containerName}" --format "{{.ID}}\t{{.Names}}\t{{.Status}}"`);
      
      if (!stdout.trim()) {
        console.log(`Container ${containerName} is not running, updating status to STOPPED`);
        await this.updateApplicationStatus(application.id, 'STOPPED');
        return;
      }

      const parts = stdout.trim().split('\t');
      const containerId = parts[0] || '';
      const statusText = parts[2] || '';

      if (statusText.includes('Up') && containerId) {
        await this.updateActiveReleaseContainer(application.id, containerId);
        return;
      }

      console.log(`Container ${containerName} is not running (exited), updating status to STOPPED`);
      await this.updateApplicationStatus(application.id, 'STOPPED');
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

  private async updateActiveReleaseContainer(applicationId: string, containerId: string): Promise<void> {
    try {
      const application = await this.prisma.application.findUnique({
        where: { id: applicationId },
        select: { activeReleaseId: true },
      });

      if (!application || !application.activeReleaseId) {
        return;
      }

      await this.prisma.release.update({
        where: { id: application.activeReleaseId },
        data: { containerId },
      });
    } catch (error) {
      console.error(`Failed to update active release container for application ${applicationId}:`, error);
    }
  }

  private async updateReleaseHealth(applicationId: string, health: string): Promise<void> {
    try {
      const application = await this.prisma.application.findUnique({
        where: { id: applicationId },
        select: { activeReleaseId: true },
      });

      if (!application || !application.activeReleaseId) {
        return;
      }

      await this.prisma.release.update({
        where: { id: application.activeReleaseId },
        data: { health },
      });
    } catch (error) {
      console.error(`Failed to update release health for application ${applicationId}:`, error);
    }
  }

  private async updateReleaseById(containerId: string, releaseId: string): Promise<void> {
    try {
      await this.prisma.release.update({
        where: { id: releaseId },
        data: { containerId },
      });
    } catch (error) {
      console.error(`Failed to update release container for release ${releaseId}:`, error);
    }
  }

  private async updateReleaseHealthById(releaseId: string, health: string): Promise<void> {
    try {
      await this.prisma.release.update({
        where: { id: releaseId },
        data: { health },
      });
    } catch (error) {
      console.error(`Failed to update release health for release ${releaseId}:`, error);
    }
  }

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
      const containerName = application.domain;
      const { stdout } = await execAsync(`docker restart ${containerName}`, {
        timeout: 60000,
      });
 
      console.log(`Restarted container for ${application.domain}:`, stdout);
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
