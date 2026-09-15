import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ApiResponse } from '../types';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { orgScope, logScope } from '../lib/scope';
import { DeploymentService } from '../services/deployment';
import * as path from 'path';
import { appFsFor, sourceFsFor } from '../lib/appFs';
import { serverForApplication } from '../lib/servers';
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
        // the source's latest build: a monorepo app's may have been started from a sibling
        const latestDeployment = await prisma.deployment.findFirst({
          where: application.sourceId ? { sourceId: application.sourceId } : { applicationId: appId },
          orderBy: {
            createdAt: 'desc',
          },
        });

        if (!latestDeployment) {
          logs = 'No deployments found for application';
        } else {
          // kept on the deployment once its build ends
          logs = latestDeployment.buildLogs
            ? latestDeployment.buildLogs.split('\n').slice(-lines).join('\n')
            : 'Build logs are not available yet';
        }
      } else {
        logs = await deploymentService.getApplicationLogsFromFiles(application.id, logType, lines);
      }
    } catch (error) {
      logs = `No logs available for ${logType}`;
    }

    return res.json({
      success: true,
      data: {
        logs,
        applicationId: appId,
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
 * be followed while the build runs (the deployment's copy only lands at the end). The
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

    // A first deploy provisions the organization on the node before anything is
    // built (its OS user, home, slice) — minutes, with no build log yet. Its own
    // live log goes first, until it is done.
    let text = '';
    const node = await serverForApplication(application.id).catch(() => null);
    const provisioning =
      node && application.organizationId
        ? await prisma.orgNode.findUnique({
            where: { organizationId_serverId: { organizationId: application.organizationId, serverId: node.id } },
            select: { state: true, log: true },
          })
        : null;
    if (provisioning && provisioning.state !== 'DONE' && provisioning.log?.trim()) {
      text = `── ${provisioning.state === 'FAILED' ? 'provisioning failed' : 'provisioning the organization on this server'} ──\n${provisioning.log.slice(-16 * 1024)}\n`;
    }

    const afs = await sourceFsFor(application.id);
    const logFile = path.posix.join(afs.appDir, 'logs', 'build.log');
    const TAIL = 64 * 1024;
    try {
      // ponytail: whole file, then the tail. A ranged SFTP read if build logs get huge.
      const buffer = await afs.readFile(logFile);
      const start = Math.max(0, buffer.length - TAIL);
      text += (start > 0 ? '…\n' : '') + buffer.subarray(start).toString('utf-8');
    } catch {
      // no build has run yet
    }

    // After BUILD COMPLETED the deploy goes on — switch, start, a health check of
    // up to a minute — and writes that to deploy.log. Without it the live view
    // sat on "BUILD COMPLETED" as if stuck. Reset at every deploy, so it is this one's.
    const deployLog = await afs.readText(path.posix.join(afs.appDir, 'logs', 'deploy.log')).catch(() => '');
    if (deployLog.trim()) text += `\n${deployLog.slice(-16 * 1024)}`;

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

    return await streamFollows(res, server, [follow]);
  } catch (error) {
    console.error('Error streaming logs:', error);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
    }
    return res.end();
  }
});

type Follow = (send: (text: string) => void, signal: AbortSignal) => Promise<unknown>;

/**
 * Run `follows` on `server` as one Server-Sent Events response, each holding
 * one SSH channel of it: refused when that would pass the server's cap, ended
 * when the client leaves or after STREAM_MAX_MS.
 */
async function streamFollows(res: Response, server: SshTarget, follows: Follow[]) {
  const open = openStreams.get(server.id) ?? 0;
  if (open + follows.length > MAX_STREAMS_PER_SERVER) {
    return res.status(429).json({ success: false, error: 'Too many live log streams on this server — close another one' } as ApiResponse);
  }
  openStreams.set(server.id, open + follows.length);

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
    await Promise.all(
      follows.map((follow) =>
        follow(send, controller.signal).catch((err: any) => {
          if (!controller.signal.aborted) send(`\n[log stream ended: ${err?.message || err}]\n`);
        }),
      ),
    );
  } finally {
    clearInterval(heartbeat);
    clearTimeout(cap);
    openStreams.set(server.id, (openStreams.get(server.id) ?? follows.length) - follows.length);
  }
  return res.end();
}

/** Every whole line of a stream, as `name | line` — its app said on each, like pm2 does. */
function tagLines(name: string, send: (text: string) => void) {
  let partial = '';
  return (text: string) => {
    const lines = (partial + text).split('\n');
    partial = lines.pop() ?? '';
    if (lines.length) send(lines.map((line) => `${name} | ${line}\n`).join(''));
  };
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A project's log, live: every app of it that has one (or `?app=` for one),
 * as Server-Sent Events. Its pm2 apps are followed as one — `pm2 logs` with a
 * regex of their names, each line keeping pm2's `0|name |` — and each app the
 * panel runs as a unit on its own, its lines tagged with its name. All on the
 * project's one node.
 */
router.get('/project/:sourceId/stream', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const type = (['combined', 'out', 'error'] as const).find((t) => t === req.query.type) ?? 'combined';
    const lines = Math.min(Math.max(parseInt(req.query.lines as string) || 100, 1), 2000);
    const apps = await prisma.application.findMany({
      where: { sourceId: req.params.sourceId as string, ...(await orgScope(req)) },
      select: { id: true, name: true, type: true, runtime: true, processName: true, serverId: true },
      orderBy: { createdAt: 'asc' },
    });
    if (apps.length === 0) return res.status(404).json({ success: false, error: 'Project not found' } as ApiResponse);
    const wanted = req.query.app ? apps.filter((app) => app.id === req.query.app) : apps;

    const pm2Apps = wanted.filter((app) => app.runtime === 'PM2' && app.processName && app.serverId);
    const unitApps = wanted.filter((app) => !app.runtime && systemd.needsUnit(app.type));
    const follows: Follow[] = [];
    let server: SshTarget | null = null;

    if (pm2Apps.length) {
      const pm2Server = await prisma.server.findUnique({ where: { id: pm2Apps[0]!.serverId! } });
      if (!pm2Server) return res.status(409).json({ success: false, error: 'These pm2 apps are not linked to a server — re-sync them' } as ApiResponse);
      server = pm2Server;
      const names = [...new Set(pm2Apps.map((app) => app.processName!))];
      // one name, or pm2's /regex/ form for several — anchored, so no other process of the server matches
      const target = names.length === 1 ? names[0]! : `/^(${names.map(escapeRegex).join('|')})$/`;
      follows.push((send, signal) => followPm2Logs(pm2Server, target, type, lines, send, signal));
    }
    for (const app of unitApps) {
      const afs = await appFsFor(app.id);
      if (!afs.node) continue;
      server ??= afs.node;
      const node = afs.node;
      follows.push((send, signal) => systemd.followLogs(node, logsDirFor(afs.appDir), type, lines, tagLines(app.name, send), signal));
    }
    if (!server || follows.length === 0) {
      return res.status(400).json({ success: false, error: 'Live logs are not available for these apps' } as ApiResponse);
    }

    return await streamFollows(res, server, follows);
  } catch (error) {
    console.error('Error streaming project logs:', error);
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


    // Create test build log entry
    const success = await deploymentService.createTestBuildLog(application.id, message || 'Test build log entry');

    if (success) {
      // Check if build log exists
      const logStatus = await deploymentService.checkBuildLogExists(application.id);
      
      return res.json({
        success: true,
        data: {
          message: 'Test build log created successfully',
          logStatus,
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


    // Check build log status
    const logStatus = await deploymentService.checkBuildLogExists(application.id);
    
    return res.json({
      success: true,
      data: {
        logStatus,
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
