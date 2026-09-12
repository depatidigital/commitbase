import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ApiResponse } from '../types';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { orgScope, logScope } from '../lib/scope';
import { DeploymentService } from '../services/deployment';
import { getBuildLogKey, downloadObjectToString } from '../services/s3Service';
import * as path from 'path';
import { appFsFor } from '../lib/appFs';
import { followPm2Logs } from '../services/appSyncService';
import * as systemd from '../services/systemdService';
import { logsDirFor } from '../lib/appPaths';
import type { SshTarget } from '../lib/runner';

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
        logs = await deploymentService.getApplicationLogsFromFiles(application.domain, logType, lines);
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

// Each live stream holds one channel on the node's pooled SSH connection, and
// sshd allows 10 per connection (MaxSessions) — shared with deploys and SFTP.
const MAX_STREAMS_PER_SERVER = 4;
// ponytail: the page reconnects when a stream ends, so a cap just recycles forgotten tabs
const STREAM_MAX_MS = 30 * 60_000;
const openStreams = new Map<string, number>();

/**
 * An app's log as Server-Sent Events: the last `lines` lines, then each new
 * one as it is written. The follow runs only while a client is connected.
 */
router.get('/application/:appId/stream', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const type = (['combined', 'out', 'error'] as const).find((t) => t === req.query.type) ?? 'combined';
    const lines = Math.min(Math.max(parseInt(req.query.lines as string) || 100, 1), 2000);

    const application = await prisma.application.findFirst({
      where: { id: req.params.appId as string, ...(await orgScope(req)) },
    });
    if (!application) {
      return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    }

    // imported pm2 apps follow pm2; apps the panel deployed follow their unit's log files
    let server: SshTarget;
    let follow: (send: (text: string) => void, signal: AbortSignal) => Promise<unknown>;
    if (application.runtime === 'PM2' && application.processName) {
      const pm2Server = application.serverId
        ? await prisma.server.findUnique({ where: { id: application.serverId } })
        : null;
      if (!pm2Server) {
        return res.status(409).json({ success: false, error: 'This pm2 app is not linked to a server — re-sync it' } as ApiResponse);
      }
      const processName = application.processName;
      server = pm2Server;
      follow = (send, signal) => followPm2Logs(pm2Server, processName, type, lines, send, signal);
    } else if (!application.runtime && systemd.needsUnit(application.type)) {
      const afs = await appFsFor(application.id);
      const node = afs.node;
      if (!node) {
        // ponytail: the panel's own disk (isolation off, dev) only polls
        return res.status(400).json({ success: false, error: 'Live logs are only available for apps on a node' } as ApiResponse);
      }
      server = node;
      follow = (send, signal) => systemd.followLogs(node, logsDirFor(afs.appDir), type, lines, send, signal);
    } else {
      return res.status(400).json({ success: false, error: 'Live logs are not available for this app' } as ApiResponse);
    }

    const open = openStreams.get(server.id) ?? 0;
    if (open >= MAX_STREAMS_PER_SERVER) {
      return res.status(429).json({ success: false, error: 'Too many live log streams on this server — close another one' } as ApiResponse);
    }
    openStreams.set(server.id, open + 1);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      // no-transform: compression() (and any proxy) would gzip-buffer the stream to nothing
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // JSON-encoded so a chunk's own newlines cannot break the event framing
    const send = (text: string) => res.write(`data: ${JSON.stringify(text)}\n\n`);

    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    const cap = setTimeout(() => controller.abort(), STREAM_MAX_MS);

    try {
      await follow(send, controller.signal);
    } catch (err: any) {
      if (!controller.signal.aborted) send(`\n[log stream ended: ${err?.message || err}]\n`);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(cap);
      openStreams.set(server.id, (openStreams.get(server.id) ?? 1) - 1);
    }
    return res.end();
  } catch (error) {
    console.error('Error streaming logs:', error);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
    }
    return res.end();
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
