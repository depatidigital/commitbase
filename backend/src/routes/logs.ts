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

    // Get logs from files using domain
    let logs = '';
    try {
      logs = await deploymentService.getApplicationLogsFromFiles(application.domain, logType, lines);
    } catch (error) {
      logs = `No logs available for ${logType}`;
    }

    res.json({
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
    res.status(500).json({
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

    // Get log file path using domain
    const appDir = path.join(process.env.APPS_DIR || './apps_dir', application.domain);
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

  } catch (error) {
    console.error('Error setting up log stream:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to setup log stream' })}\n\n`);
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

    res.json({
      success: true,
      data: logs,
      message: 'System logs retrieved successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error fetching system logs:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Get PM2 status and logs
router.get('/pm2/status', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const processes = await deploymentService.listPM2Processes();
    
    // Filter processes for current user's applications
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

    const userAppIds = userApplications.map(app => app.id);
    const userProcesses = processes.filter((process: any) => 
      userAppIds.some(appId => process.name.includes(appId))
    );

    res.json({
      success: true,
      data: userProcesses,
      message: 'PM2 status retrieved successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error fetching PM2 status:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

export default router; 