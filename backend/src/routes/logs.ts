import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ApiResponse } from '../types';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { DeploymentService } from '../services/deployment';
import * as fs from 'fs/promises';
import * as path from 'path';

const router = Router();
const deploymentService = new DeploymentService();

// Get application logs
router.get('/application/:appId', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { appId } = req.params;
    const lines = parseInt(req.query.lines as string) || 100;
    const logType = (req.query.type as string) || 'combined'; // combined, out, error, build

    if (!appId) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    // Verify application belongs to user
    const application = await prisma.application.findFirst({
      where: {
        id: appId,
        userId: req.user!.userId,
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    // Get logs based on type
    let logs = '';
    try {
      if (logType === 'build') {
        logs = await deploymentService.getApplicationLogsFromFiles(application.domain, logType, lines);
      } else {
        logs = await deploymentService.getApplicationLogs(application.domain, lines);
      }
    } catch (error) {
      logs = `No logs available for ${logType}`;
    }

    return res.json({
      success: true,
      data: {
        logs,
        applicationId: appId,
        domain: application.domain,
        logType,
        lines: lines,
      },
      message: 'Logs retrieved successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error fetching logs:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Get real-time logs (stream)
router.get('/application/:appId/stream', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { appId } = req.params;
    const logType = (req.query.type as string) || 'combined';

    if (!appId) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    // Verify application belongs to user
    const application = await prisma.application.findFirst({
      where: {
        id: appId,
        userId: req.user!.userId,
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    // Set up SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control',
    });

    // Send initial connection message
    res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Log stream started' })}\n\n`);

    // Get logs based on type
    if (!application.domain) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Application domain not found' })}\n\n`);
      return;
    }

    if (logType === 'build') {
      // For build logs, monitor file changes
      const appDir = path.join(process.env.APPS_DIR || './apps_dir', application.domain);
      const logsDir = path.join(appDir, 'logs');
      const logFile = path.join(logsDir, 'build.log');

      // Monitor log file for changes
      let lastSize = 0;
      const interval = setInterval(async () => {
        try {
          const stats = await fs.stat(logFile);
          if (stats.size > lastSize) {
            const stream = require('fs').createReadStream(logFile, {
              start: lastSize,
              end: stats.size,
            });

            stream.on('data', (chunk: Buffer) => {
              const lines = chunk.toString().split('\n').filter(line => line.trim());
              lines.forEach(line => {
                res.write(`data: ${JSON.stringify({ type: 'log', message: line })}\n\n`);
              });
            });

            lastSize = stats.size;
          }
        } catch (error) {
          // Log file doesn't exist or other error
          res.write(`data: ${JSON.stringify({ type: 'error', message: 'Log file not available' })}\n\n`);
        }
      }, 1000);

      // Clean up on client disconnect
      req.on('close', () => {
        clearInterval(interval);
      });
    } else {
      const { exec } = require('child_process');
      const dockerLogsProcess = exec(`docker logs -f --tail=100 ${application.domain}`);

      dockerLogsProcess.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(line => line.trim());
        lines.forEach(line => {
          res.write(`data: ${JSON.stringify({ type: 'log', message: line })}\n\n`);
        });
      });

      dockerLogsProcess.stderr?.on('data', (data: Buffer) => {
        res.write(`data: ${JSON.stringify({ type: 'error', message: data.toString() })}\n\n`);
      });

      // Clean up on client disconnect
      req.on('close', () => {
        dockerLogsProcess.kill();
      });
    }

    return;

  } catch (error) {
    console.error('Error setting up log stream:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to setup log stream' })}\n\n`);
    return;
  }
});

// Test build log functionality
router.post('/test-build-log/:appId', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { appId } = req.params;
    const { message } = req.body;

    if (!appId) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    // Verify application belongs to user
    const application = await prisma.application.findFirst({
      where: {
        id: appId,
        userId: req.user!.userId,
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    if (!application.domain) {
      return res.status(400).json({
        success: false,
        error: 'Application domain is required',
      } as ApiResponse);
    }

    // Create test build log entry
    const success = await deploymentService.createTestBuildLog(application.domain, message || 'Test build log entry');

    if (success) {
      // Check if build log exists
      const logStatus = await deploymentService.checkBuildLogExists(application.domain);
      
      return res.json({
        success: true,
        data: {
          message: 'Test build log created successfully',
          logStatus,
          domain: application.domain,
        },
        message: 'Test build log created successfully',
      } as ApiResponse);
    } else {
      return res.status(500).json({
        success: false,
        error: 'Failed to create test build log',
      } as ApiResponse);
    }
  } catch (error) {
    console.error('Error creating test build log:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Check build log status
router.get('/build-log-status/:appId', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { appId } = req.params;

    if (!appId) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    // Verify application belongs to user
    const application = await prisma.application.findFirst({
      where: {
        id: appId,
        userId: req.user!.userId,
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    if (!application.domain) {
      return res.status(400).json({
        success: false,
        error: 'Application domain is required',
      } as ApiResponse);
    }

    // Check build log status
    const logStatus = await deploymentService.checkBuildLogExists(application.domain);
    
    return res.json({
      success: true,
      data: {
        logStatus,
        domain: application.domain,
        applicationId: appId,
      },
      message: 'Build log status retrieved successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error checking build log status:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Get system logs
router.get('/system', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const lines = parseInt(req.query.lines as string) || 100;
    const logType = (req.query.type as string) || 'all'; // all, error, warn, info

    // Get logs from database
    const whereClause: any = {
      userId: req.user!.userId,
    };

    if (logType !== 'all') {
      whereClause.level = logType.toUpperCase();
    }

    const logs = await prisma.log.findMany({
      where: whereClause,
      orderBy: {
        timestamp: 'desc',
      },
      take: lines,
      include: {
        application: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return res.json({
      success: true,
      data: logs,
      message: 'System logs retrieved successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error fetching system logs:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Get Docker container status and logs
router.get('/docker/status', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const containers = await deploymentService.listDockerContainers();
    
    // Filter containers for current user's applications
    const userApplications = await prisma.application.findMany({
      where: {
        userId: req.user!.userId,
      },
      select: {
        id: true,
        name: true,
        domain: true,
      },
    });

    const userDomains = userApplications.map(app => app.domain);
    const userContainers = containers.filter((container: any) => 
      userDomains.some(domain => container.Names.includes(domain))
    );

    res.json({
      success: true,
      data: userContainers,
      message: 'Docker container status retrieved successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error fetching Docker container status:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

export default router; 
