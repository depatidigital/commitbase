import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ApiResponse } from '../types';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { orgScope, logScope } from '../lib/scope';
import { DeploymentService } from '../services/deployment';
import { getBuildLogKey, downloadObjectToString } from '../services/s3Service';
import * as path from 'path';
import { appFsFor } from '../lib/appFs';

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
        ...(await orgScope(req)),
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    let logs = '';
    try {
      if (logType === 'build') {
        const latestDeployment = await prisma.deployment.findFirst({
          where: {
            applicationId: appId,
          },
          orderBy: {
            createdAt: 'desc',
          },
        });

        if (!latestDeployment) {
          logs = 'No deployments found for application';
        } else {
          const key = getBuildLogKey(latestDeployment.applicationId, latestDeployment.id);

          if (!key) {
            logs = 'Build logs are not available (S3 not configured)';
          } else {
            const approxBytes = Math.max(lines * 500, 5000);
            const content = await downloadObjectToString(key, approxBytes);

            if (!content) {
              logs = 'Build logs are not available in S3';
            } else {
              const logLines = content.split('\n');
              logs = logLines.slice(-lines).join('\n');
            }
          }
        }
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

/**
 * The build log of the deploy in progress, read straight from disk so it can
 * be followed while the build runs (the S3 copy only lands at the end). The
 * last 64 KB is plenty for a live view; the full log is on the deployment.
 */
router.get('/application/:appId/build-live', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({
      where: { id: req.params.appId as string, ...(await orgScope(req)) },
      include: { organization: { select: { slug: true } } },
    });
    if (!application) {
      return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    }

    const afs = await appFsFor(application.id);
    const logFile = path.posix.join(afs.appDir, 'logs', 'build.log');
    const TAIL = 64 * 1024;
    let text = '';
    try {
      // ponytail: whole file, then the tail. A ranged SFTP read if build logs get huge.
      const buffer = await afs.readFile(logFile);
      const start = Math.max(0, buffer.length - TAIL);
      text = (start > 0 ? '…\n' : '') + buffer.subarray(start).toString('utf-8');
    } catch {
      // no build has run yet
    }

    return res.json({ success: true, data: { logs: text } } as ApiResponse);
  } catch (error) {
    console.error('Error reading live build log:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
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
        ...(await orgScope(req)),
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
        ...(await orgScope(req)),
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
      ...(await logScope(req)),
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

export default router; 
