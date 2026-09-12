import { Router, Request, Response } from 'express';
import { AppType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { CreateApplicationSchema, UpdateApplicationSchema, ApiResponse, Application, PaginatedResponse } from '../types';
import { validateRequest } from '../middleware/validation';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { paging, contains } from '../lib/paging';
import { orgScope, resolveOwnedDomain } from '../lib/scope';
import { DeploymentService } from '../services/deployment';
import { getStaticSiteBaseUrl } from '../services/s3Service';
import { ensureSiteBucket, uploadSiteObject, listSiteObjects, deleteSiteObjects } from '../services/r2Service';
import { configureCaddyForStaticApplication, removeCaddySite, staticRouteError } from '../services/caddyService';
import { ensureAppHostname, removeAppHostname, checkAppHostname } from '../services/appDnsService';
import { serverForApplication } from '../lib/servers';
import { healthFor } from '../services/heartbeatService';
import * as systemd from '../services/systemdService';
import { appFsFor } from '../lib/appFs';
import { detectFromFiles, detectFromRepo, listRemoteBranches, DETECT_FILES, DetectInput } from '../lib/projectDetect';
import { syncServerApps, scanServerApps, controlPm2Process } from '../services/appSyncService';
import { adoptCaddySites } from '../services/caddyMigrationService';
import { healCaddyRoutes, snapshotCaddyConfig, restoreCaddyConfig } from '../services/caddySnapshotService';
import { requireRole } from '../middleware/auth';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';

const router = Router();
const deploymentService = new DeploymentService();

/**
 * List order for ?sort=&order=. Unsorted, what needs attention leads: AppStatus
 * is declared RUNNING, STOPPED, ERROR, DEPLOYING, BUILDING, so descending puts
 * work in flight and broken apps above the healthy ones. Name breaks every tie
 * so a page never reshuffles between refetches.
 */
const sortOrder = (sort: unknown, order: unknown): any[] => {
  const direction = order === 'desc' ? 'desc' : 'asc';
  const byName = { name: 'asc' as const };

  switch (sort) {
    case 'name':
      return [{ name: direction }];
    case 'status':
      return [{ status: direction }, byName];
    case 'type':
      return [{ type: direction }, byName];
    case 'organization':
      return [{ organization: { name: direction } }, byName];
    case 'server':
      return [{ server: { name: direction } }, byName];
    case 'createdAt':
      // a sync creates a batch within the same moment
      return [{ createdAt: direction }, byName];
    default:
      return [{ status: 'desc' }, byName];
  }
};

/**
 * Apps discovered by the server sync are owned by pm2, not by our systemd
 * deployer, so start/stop/restart route to pm2 for them. Returns null when the
 * app is not pm2-managed and the caller should fall through to systemd.
 */
async function handlePm2Action(
  application: { id: string; runtime: string | null; processName: string | null; serverId: string | null },
  action: 'start' | 'stop' | 'restart',
  res: Response
): Promise<Response | null> {
  if (application.runtime !== 'PM2' || !application.processName) {
    return null;
  }

  // pm2 runs on the node the sync found the process on, not on the control plane
  const server = application.serverId
    ? await prisma.server.findUnique({ where: { id: application.serverId } })
    : null;
  if (!server) {
    return res.status(409).json({ success: false, error: 'This pm2 app is not linked to a server — re-sync it' } as ApiResponse);
  }

  const result = await controlPm2Process(server, application.processName, action);

  if (!result.success) {
    await prisma.application.update({ where: { id: application.id }, data: { status: 'ERROR' } });
    return res.status(500).json({ success: false, error: result.output } as ApiResponse);
  }

  await prisma.application.update({
    where: { id: application.id },
    data: { status: action === 'stop' ? 'STOPPED' : 'RUNNING' },
  });

  return res.json({
    success: true,
    data: { runtime: 'PM2', processName: application.processName },
    message: `pm2 ${action} succeeded`,
  } as ApiResponse);
}

/**
 * The git account may only be one the caller connected themselves. Without this
 * check an application could be pointed at somebody else's OAuth token and
 * deploy from their private repositories.
 */
async function assertOwnGitAccount(
  gitAccountId: string | null | undefined,
  userId: string,
  res: Response
): Promise<boolean> {
  if (!gitAccountId) return true;

  const account = await prisma.gitAccount.findFirst({ where: { id: gitAccountId, userId } });
  if (!account) {
    res.status(403).json({ success: false, error: 'Unknown git account' } as ApiResponse);
    return false;
  }
  return true;
}

// Preview what is running on the server without touching the database
router.get('/scan', authenticateToken, requireRole(['SUPERADMIN']), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const apps = await scanServerApps();
    return res.json({ success: true, data: apps, message: `${apps.length} apps found on the server` } as ApiResponse);
  } catch (error) {
    console.error('Error scanning server apps:', error);
    return res.status(500).json({ success: false, error: 'Failed to scan server apps' } as ApiResponse);
  }
});

// Import/refresh the server inventory (pm2 processes + Caddy sites)
router.post('/sync', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await syncServerApps(req.user!.userId);
    return res.json({
      success: true,
      data: result,
      message: `${result.created} imported, ${result.updated} updated`,
    } as ApiResponse);
  } catch (error) {
    console.error('Error syncing server apps:', error);
    return res.status(500).json({ success: false, error: 'Failed to sync server apps' } as ApiResponse);
  }
});

// Get all applications for the authenticated user
// Framework detection for the "new app" form. Either the files the browser
// already read (upload flow) or a repository URL (git flow — shallow clone of
// the detection files only).
/**
 * Move the file-based sites in /etc/caddy/sites onto the admin API, so routes
 * have one source of truth. A dry run by default: pass `apply: true` to push.
 *
 * After applying, drop the `import /etc/caddy/sites/*.caddy` line from the
 * Caddyfile — the files stay as the record each later run reads.
 */
router.post('/caddy/adopt', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    // one node per call — say which, since each runs its own Caddy
    const node = await prisma.server.findFirst({
      where: req.body?.serverId ? { id: String(req.body.serverId) } : {},
      orderBy: { createdAt: 'asc' },
      select: {
      id: true,
      hostname: true,
      sshUser: true,
      sshPort: true,
      sshKeyPath: true,
      authMethod: true,
      sshPassword: true,
    },
    });

    if (!node) {
      return res.status(400).json({ success: false, error: 'No server to adopt sites from' } as ApiResponse);
    }

    const result = await adoptCaddySites(node, { apply: req.body?.apply === true });

    return res.json({
      success: true,
      data: result,
      message:
        req.body?.apply === true
          ? `Adopted ${result.applied} route(s), ${result.skipped} skipped`
          : `Dry run: ${result.sites.length} site(s) found, ${result.skipped} need attention`,
    } as ApiResponse);
  } catch (error: any) {
    console.error('Error adopting Caddy sites:', error);
    return res.status(502).json({
      success: false,
      error: error?.message || 'Could not read the Caddy site files',
    } as ApiResponse);
  }
});

/** Store the live Caddy config now, rather than waiting for the watchdog tick. */
router.post('/caddy/snapshot', authenticateToken, requireRole(['SUPERADMIN']), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json({ success: true, message: await snapshotCaddyConfig() } as ApiResponse);
  } catch (error: any) {
    console.error('Error snapshotting Caddy config:', error);
    return res.status(502).json({
      success: false,
      error: error?.message || 'Could not read the Caddy config',
    } as ApiResponse);
  }
});

/** Push the newest snapshot back — for a reload that took the routes with it. */
router.post('/caddy/restore', authenticateToken, requireRole(['SUPERADMIN']), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await restoreCaddyConfig();

    return res.json({
      success: result.restored,
      data: result,
      ...(result.restored
        ? { message: `Restored ${result.hosts.length} route(s) from the last snapshot` }
        : { error: 'No snapshot has been taken yet' }),
    } as ApiResponse);
  } catch (error: any) {
    console.error('Error restoring Caddy config:', error);
    return res.status(502).json({
      success: false,
      error: error?.message || 'Could not restore the Caddy config',
    } as ApiResponse);
  }
});

/** Compare live Caddy routes against what should be there, and heal the gaps. */
router.post('/caddy/heal', authenticateToken, requireRole(['SUPERADMIN']), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json({ success: true, message: await healCaddyRoutes() } as ApiResponse);
  } catch (error: any) {
    console.error('Error healing Caddy routes:', error);
    return res.status(502).json({
      success: false,
      error: error?.message || 'Could not reach Caddy',
    } as ApiResponse);
  }
});

router.post('/detect', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { repository, branch, files } = req.body || {};

    if (files && typeof files === 'object') {
      const input: DetectInput = {};
      for (const name of DETECT_FILES) {
        if (typeof files[name] === 'string') input[name] = String(files[name]).slice(0, 256 * 1024);
      }
      return res.json({ success: true, data: detectFromFiles(input) } as ApiResponse);
    }

    if (typeof repository === 'string' && repository.trim()) {
      const detected = await detectFromRepo(repository.trim(), String(branch || 'main').trim() || 'main');
      return res.json({ success: true, data: detected } as ApiResponse);
    }

    return res.status(400).json({ success: false, error: 'Send files or a repository' } as ApiResponse);
  } catch (error: any) {
    return res.status(400).json({
      success: false,
      error: `Could not inspect the project: ${error?.stderr || error?.message || String(error)}`.slice(0, 500),
    } as ApiResponse);
  }
});

/** Branches and the default branch of a pasted repository URL, for the add-app form. */
router.post('/branches', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  const repository = String(req.body?.repository ?? '').trim();
  if (!repository) {
    return res.status(400).json({ success: false, error: 'Repository URL is required' } as ApiResponse);
  }

  try {
    return res.json({ success: true, data: await listRemoteBranches(repository) } as ApiResponse);
  } catch (error: any) {
    return res.status(400).json({
      success: false,
      error: `Could not read the branches: ${error?.stderr || error?.message || String(error)}`.slice(0, 500),
    } as ApiResponse);
  }
});

router.get('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, limit, skip, search, organizationId } = paging(req);
    // ?type=PHP, ?serverId=… — anything not an AppType value is ignored, not a 500
    const type = String(req.query.type ?? '').trim().toUpperCase();
    const serverId = String(req.query.serverId ?? '').trim();
    const where = {
      ...(await orgScope(req)),
      // ?organizationId=unassigned: the synced rows nobody has claimed yet
      ...(organizationId && { organizationId: organizationId === 'unassigned' ? null : organizationId }),
      ...((Object.values(AppType) as string[]).includes(type) && { type: type as AppType }),
      ...(serverId && { serverId }),
      ...(search && { OR: [{ name: contains(search) }, { domain: contains(search) }] }),
    };

    const [applications, total] = await Promise.all([
      prisma.application.findMany({
        where,
        include: {
          organization: { select: { id: true, name: true, slug: true } },
          // which box it runs on — with more than one node, the row is
          // ambiguous without it
          server: { select: { id: true, name: true } },
          deployments: {
            orderBy: {
              createdAt: 'desc',
            },
            take: 1,
          },
        },
        skip,
        take: limit,
        orderBy: sortOrder(req.query.sort, req.query.order),
      }),
      prisma.application.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);

    res.json({
      success: true,
      data: {
        data: applications,
        pagination: {
          page,
          limit,
          total,
          totalPages,
        },
      },
      message: 'Applications retrieved successfully',
    } as ApiResponse<PaginatedResponse<Application>>);
  } catch (error) {
    console.error('Error fetching applications:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Get a specific application by ID
/**
 * Give many applications an owner at once.
 *
 * A node's sites arrive from the sync unassigned, and there can be fifty of
 * them — assigning one at a time is the whole reason this exists.
 */
router.patch('/bulk-assign', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { ids, organizationId } = req.body as { ids?: unknown; organizationId?: unknown };

    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) {
      return res.status(400).json({
        success: false,
        error: 'ids must be a non-empty array of application IDs',
      } as ApiResponse);
    }

    if (organizationId !== null && typeof organizationId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'organizationId must be an organization ID or null',
      } as ApiResponse);
    }

    if (organizationId) {
      const organization = await prisma.organization.findUnique({ where: { id: organizationId } });
      if (!organization) {
        return res.status(404).json({ success: false, error: 'Organization not found' } as ApiResponse);
      }
    }

    const { count } = await prisma.application.updateMany({
      where: { id: { in: ids as string[] } },
      data: { organizationId: (organizationId as string) || null },
    });

    return res.json({
      success: true,
      data: { count },
      message: `${count} application(s) updated`,
    } as ApiResponse);
  } catch (error) {
    console.error('Error bulk assigning applications:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/**
 * Health for a set of applications: the recent beats, the day's uptime, and
 * whether the failures are enough to call it down.
 *
 * Batched because the list renders one bar per row — a request per row would
 * be 25 round trips for one screen.
 */
router.get('/health', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ids = String(req.query.ids ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 100);

    if (ids.length === 0) return res.json({ success: true, data: {} } as ApiResponse);

    // only applications the caller may see — the ids arrive from the client
    const visible = await prisma.application.findMany({
      where: { id: { in: ids }, ...(await orgScope(req)) },
      select: { id: true },
    });

    return res.json({
      success: true,
      data: await healthFor('APPLICATION', visible.map((app) => app.id)),
    } as ApiResponse);
  } catch (error) {
    console.error('Error reading application health:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

router.get('/:id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    console.log('Get application request:', {
      params: req.params,
      url: req.url,
      method: req.method
    });

    const { id } = req.params || {};

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    const application = await prisma.application.findFirst({
      where: {
        id,
        ...(await orgScope(req)),
      },
      include: {
        deployments: {
          orderBy: {
            createdAt: 'desc',
          },
        },
        // where it runs: the node the sync found it on, else its organization's
        // node (the one serverForApplication routes through). Never SSH fields.
        server: { select: { id: true, name: true, hostname: true, publicIp: true, tags: true } },
        organization: {
          select: { server: { select: { id: true, name: true, hostname: true, publicIp: true, tags: true } } },
        },
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    // R2 sites are served on their own hostname. Only a site that was deployed
    // before R2 (deployed, but no bucket origin) still lives at the old S3
    // prefix — a never-uploaded one has no URL at all.
    const staticSiteUrl =
      application.type === 'STATIC'
        ? (application as any).staticOrigin
          ? `https://${application.domain}`
          : application.lastDeployment
            ? getStaticSiteBaseUrl(application.id)
            : null
        : undefined;

    return res.json({
      success: true,
      data: {
        ...application,
        staticSiteUrl,
        placement: application.server ?? application.organization?.server ?? null,
      },
      message: 'Application retrieved successfully',
    } as ApiResponse<Application & { staticSiteUrl?: string | null }>);
  } catch (error) {
    console.error('Error fetching application:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Create a new application
router.post('/', authenticateToken, validateRequest(CreateApplicationSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, type, repository, branch, buildCommand, startCommand, port, envVars, gitAccountId } = req.body;
    const domain = String(req.body.domain || '').trim().toLowerCase();

    if (!(await assertOwnGitAccount(gitAccountId, req.user!.userId, res))) return;

    // Check if domain already exists
    const existingApp = await prisma.application.findUnique({
      where: { domain },
    });

    if (existingApp) {
      return res.status(400).json({
        success: false,
        error: 'Domain already in use',
      } as ApiResponse);
    }

    // Ownership boundary: the hostname must sit under a domain owned by one of the
    // caller's organizations. The app inherits that organization.
    const parentDomain = await resolveOwnedDomain(req, domain);
    if (!parentDomain) {
      return res.status(403).json({
        success: false,
        error: 'Domain is not assigned to your organization. Ask an administrator to assign it first.',
      } as ApiResponse);
    }

    const application = await prisma.application.create({
      data: {
        name,
        domain,
        type,
        repository,
        gitAccountId,
        branch,
        buildCommand,
        startCommand,
        port,
        envVars,
        userId: req.user!.userId,
        domainId: parentDomain.id,
        organizationId: parentDomain.organizationId,
      },
    });

    // Point the hostname at the platform now, so the app is reachable the
    // moment it deploys. A hostname already pointing somewhere else is left
    // alone and reported — the caller can retry with ?force=1.
    const dns = await ensureAppHostname(application, { force: req.query.force === '1' }).catch(
      (error: any) => ({ state: 'unavailable' as const, detail: String(error?.message ?? 'DNS setup failed') }),
    );

    return res.status(201).json({
      success: true,
      data: { ...application, dns },
      message:
        dns.state === 'conflict' || dns.state === 'unavailable'
          ? `Application created, but DNS was not set up: ${dns.detail}`
          : 'Application created successfully',
    } as ApiResponse<Application>);
  } catch (error) {
    console.error('Error creating application:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// ---------------------------------------------------------------------------
// Uploaded sources: an app can be deployed from a folder the user picked in the
// browser instead of a git repository. Files land straight in the app's
// sources/ directory, which is what the deploy step builds from.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 5000 },
});

/** Keeps an uploaded relative path inside sources/ — a client can send anything. */
const safeRelativePath = (raw: string): string | null => {
  const cleaned = String(raw || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();

  if (!cleaned) return null;
  if (cleaned.split('/').some((part) => part === '..' || part === '.' || !part)) return null;
  if (path.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) return null;

  return cleaned;
};

router.post(
  '/:id/source',
  authenticateToken,
  upload.array('files'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const files = (req.files as Express.Multer.File[]) || [];

      if (files.length === 0) {
        return res.status(400).json({ success: false, error: 'No files uploaded' } as ApiResponse);
      }

      const application = await prisma.application.findFirst({
        where: { id: id as string, ...(await orgScope(req)) },
      });

      if (!application) {
        return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
      }

      // paths[i] carries the file's path inside the picked folder; a plain file
      // upload has none, so fall back to its own name
      const rawPaths = req.body?.paths;
      const paths: string[] = Array.isArray(rawPaths) ? rawPaths : rawPaths ? [rawPaths] : [];

      // Static sites live in their own R2 bucket and are served through
      // Cloudflare, so their files never touch our disk. Runtime apps still
      // need a sources/ tree for the build step.
      if (application.type === 'STATIC') {
        // An upload is this app's deploy, so it gets a row in the history —
        // including when it fails, which is when the history matters most.
        const deployment = await prisma.deployment.create({
          data: { status: 'DEPLOYING', applicationId: application.id, userId: req.user!.userId },
        });
        const fail = async (status: number, message: string) => {
          await prisma.deployment.update({
            where: { id: deployment.id },
            data: { status: 'FAILED', deployLogs: message },
          });
          await prisma.application.update({ where: { id: application.id }, data: { status: 'ERROR' } });
          return res.status(status).json({ success: false, error: message } as ApiResponse);
        };

        let bucket: string;
        let origin: string;
        const uploadedKeys = new Set<string>();
        let removed = 0;

        try {
          ({ bucket, origin } = await ensureSiteBucket(application.domain));

          for (const [index, file] of files.entries()) {
            const relative = safeRelativePath(paths[index] || file.originalname);
            if (!relative) continue;

            if (await uploadSiteObject(bucket, relative, file.buffer)) uploadedKeys.add(relative);
          }

          // ?replace: the upload becomes the whole site — whatever it no longer
          // contains goes. Only after every file landed, so a failed upload
          // never leaves the site half-deleted.
          if (uploadedKeys.size > 0 && (req.body?.replace === 'true' || req.body?.replace === true)) {
            const stale = (await listSiteObjects(bucket)).map((o) => o.key).filter((key) => !uploadedKeys.has(key));
            removed = await deleteSiteObjects(bucket, stale);
          }
        } catch (error: any) {
          return fail(500, error?.message || 'Could not upload to the site bucket');
        }

        const uploaded = uploadedKeys.size;
        if (uploaded === 0) {
          return fail(400, 'No usable files in the upload');
        }

        // recorded once the files are in, so a redeploy can retry the route
        // without asking for the files again
        await prisma.application.update({
          where: { id: application.id },
          data: { staticBucket: bucket, staticOrigin: origin },
        });

        try {
          await configureCaddyForStaticApplication(
            await serverForApplication(application.id),
            application.id,
            application.domain,
            origin,
          );
        } catch (error: any) {
          return fail(502, staticRouteError(error));
        }

        // DNS is a warning, not a failure: the hostname may live in a zone
        // someone else runs, and the site itself is up
        const dns = await ensureAppHostname(application).catch(
          (error: any) => ({ state: 'unavailable' as const, detail: String(error?.message ?? 'DNS setup failed') }),
        );
        const dnsWarning =
          dns.state === 'conflict' || dns.state === 'unavailable' ? `\nDNS was not set up: ${dns.detail}` : '';

        await prisma.deployment.update({
          where: { id: deployment.id },
          data: {
            status: 'SUCCESS',
            deployLogs:
              `Uploaded ${uploaded} file${uploaded === 1 ? '' : 's'} to Cloudflare R2 (${bucket})` +
              (removed ? `, removed ${removed} no longer in the upload` : '') +
              dnsWarning,
          },
        });
        await prisma.application.update({
          where: { id: application.id },
          data: { status: 'RUNNING', lastDeployment: new Date() },
        });

        return res.json({
          success: true,
          data: { files: uploaded, dns },
          message:
            dns.state === 'conflict' || dns.state === 'unavailable'
              ? `Static files uploaded, but DNS was not set up: ${dns.detail}`
              : 'Static files uploaded to Cloudflare R2',
        } as ApiResponse);
      }

      // on the org's node when the app lives there (lib/appFs.ts)
      const afs = await deploymentService.prepareAppDirectory(application.id);
      const sourcesDir = path.posix.join(afs.appDir, 'sources');

      // a fresh upload replaces the previous one — leftovers would ship in the build
      await afs.rm(sourcesDir, { recursive: true, force: true });
      await afs.mkdir(sourcesDir);

      let written = 0;
      for (const [index, file] of files.entries()) {
        const relative = safeRelativePath(paths[index] || file.originalname);
        if (!relative) continue;

        const target = path.posix.join(sourcesDir, relative);
        if (!target.startsWith(sourcesDir + '/')) continue;

        // ponytail: one mkdir + one SFTP write per file. Tar over one channel if big uploads get slow.
        await afs.mkdir(path.posix.dirname(target));
        await afs.writeFile(target, file.buffer);
        written += 1;
      }

      if (written === 0) {
        return res.status(400).json({ success: false, error: 'No usable files in the upload' } as ApiResponse);
      }

      return res.json({
        success: true,
        data: { files: written },
        message: 'Source files uploaded successfully',
      } as ApiResponse);
    } catch (error) {
      console.error('Error uploading application source:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
    }
  }
);

// ---------------------------------------------------------------------------
// Static site files: what is in the app's R2 bucket, and removing some of it.
// Adding files goes through POST /:id/source like any upload (with replace=true
// the upload becomes the whole site). No rename/move: a static site is
// redeployed whole, not edited in place.

/** The static app with its bucket, or the response that says why not. */
async function siteBucketFor(req: AuthenticatedRequest, res: Response) {
  const application = await prisma.application.findFirst({
    where: { id: req.params.id as string, ...(await orgScope(req)) },
  });
  if (!application) {
    res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    return null;
  }
  if (application.type !== 'STATIC' || !application.staticBucket) {
    res.status(400).json({ success: false, error: 'This app has no uploaded site files' } as ApiResponse);
    return null;
  }
  return application as typeof application & { staticBucket: string };
}

router.get('/:id/files', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await siteBucketFor(req, res);
    if (!application) return;

    return res.json({
      success: true,
      data: {
        // public bucket host, so a file can be opened before DNS points here
        origin: application.staticOrigin,
        files: await listSiteObjects(application.staticBucket),
      },
    } as ApiResponse);
  } catch (error: any) {
    console.error('Error listing site files:', error);
    return res.status(502).json({ success: false, error: error?.message || 'Could not list the files' } as ApiResponse);
  }
});

router.delete('/:id/files', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await siteBucketFor(req, res);
    if (!application) return;

    const raw: unknown[] = Array.isArray(req.body?.keys) ? req.body.keys : [];
    // same shape check as uploads: plain relative paths, no traversal
    const keys = raw.map((key) => safeRelativePath(String(key))).filter((key): key is string => !!key);
    if (keys.length === 0) {
      return res.status(400).json({ success: false, error: 'No files to delete' } as ApiResponse);
    }

    const deleted = await deleteSiteObjects(application.staticBucket, keys);
    return res.json({ success: true, data: { deleted } } as ApiResponse);
  } catch (error: any) {
    console.error('Error deleting site files:', error);
    return res.status(502).json({ success: false, error: error?.message || 'Could not delete the files' } as ApiResponse);
  }
});

// Update an application
router.put('/:id', authenticateToken, validateRequest(UpdateApplicationSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    // no request logging here: the body carries the app's env vars (secrets)
    const { id } = req.params || {};
    const { name, domain, type, repository, branch, buildCommand, startCommand, port, envVars, gitAccountId } = req.body || {};
    console.log(req.body);
    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    // Check if application exists and belongs to user
    const existingApp = await prisma.application.findFirst({
      where: {
        id,
        ...(await orgScope(req)),
      },
    });

    if (!existingApp) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    if (!(await assertOwnGitAccount(gitAccountId, req.user!.userId, res))) return;

    // Check if new domain conflicts with existing application
    let domainId: string | undefined;
    let organizationId: string | null | undefined;
    const normalizedDomain = domain ? String(domain).trim().toLowerCase() : undefined;

    if (normalizedDomain && normalizedDomain !== existingApp.domain) {
      const domainConflict = await prisma.application.findUnique({
        where: { domain: normalizedDomain },
      });

      if (domainConflict) {
        return res.status(400).json({
          success: false,
          error: 'Domain already in use',
        } as ApiResponse);
      }

      // Same ownership boundary as create — a rename must not escape the tenant
      const parentDomain = await resolveOwnedDomain(req, normalizedDomain);
      if (!parentDomain) {
        return res.status(403).json({
          success: false,
          error: 'Domain is not assigned to your organization. Ask an administrator to assign it first.',
        } as ApiResponse);
      }
      domainId = parentDomain.id;
      organizationId = parentDomain.organizationId;
    }

    // Update application
    const updatedApp = await prisma.application.update({
      where: { id },
      data: {
        name,
        ...(normalizedDomain && { domain: normalizedDomain }),
        ...(domainId && { domainId }),
        ...(organizationId !== undefined && { organizationId }),
        type,
        repository,
        // undefined leaves it alone; null deliberately clears it
        ...(gitAccountId !== undefined && { gitAccountId }),
        branch,
        buildCommand,
        startCommand,
        port,
        envVars,
      },
    });
    console.log('Updated application:', updatedApp, {
      port: port,
    });
    return res.json({
      success: true,
      data: updatedApp,
      message: 'Application updated successfully',
    } as ApiResponse<Application>);
  } catch (error) {
    console.error('Error updating application:', error);
    console.error('Request details:', {
      params: req.params,
      body: req.body,
      url: req.url,
      method: req.method,
      headers: req.headers
    });
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Delete an application
router.delete('/:id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    console.log('Delete application request:', {
      params: req.params,
      url: req.url,
      method: req.method
    });

    const { id } = req.params || {};

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    // Check if application exists and belongs to user
    const application = await prisma.application.findFirst({
      where: {
        id,
        ...(await orgScope(req)),
      },
      include: { organization: { select: { slug: true } } },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    // Tear down what the deploy created: the unit, the site config, the files.
    // Inventory-imported apps (runtime set) are not ours to remove from the box.
    if (!application.runtime) {
      await systemd.removeApplication(application).catch((error) => {
        console.error(`Failed to remove unit for ${application.domain}:`, error);
      });
      await removeCaddySite(await serverForApplication(application.id), application.domain).catch(() => {});
      await removeAppHostname(application);
      const afs = await appFsFor(application.id).catch(() => null);
      await afs?.rm(afs.appDir, { recursive: true, force: true }).catch(() => {});
    }

    // Delete application
    await prisma.application.delete({
      where: { id },
    });

    return res.json({
      success: true,
      message: 'Application deleted successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error deleting application:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Start existing application (without redeploying)
router.post('/:id/start-existing', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    console.log('Start existing application request:', {
      params: req.params,
      url: req.url,
      method: req.method
    });

    const { id } = req.params || {};

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    // Get application
    const application = await prisma.application.findFirst({
      where: {
        id,
        ...(await orgScope(req)),
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    const pm2Handled = await handlePm2Action(application, 'start', res);
    if (pm2Handled) return pm2Handled;

    if (application.status === 'RUNNING') {
      return res.status(400).json({
        success: false,
        error: 'Application is already running',
      } as ApiResponse);
    }

    await prisma.application.update({
      where: { id },
      data: { status: 'DEPLOYING' },
    });

    // Start the existing unit without redeploying
    const started = await deploymentService.startApplication(application.domain);

    if (started) {
      await prisma.application.update({
        where: { id },
        data: { status: 'RUNNING' },
      });

      return res.json({
        success: true,
        message: 'Application started successfully',
      } as ApiResponse);
    } else {
      await prisma.application.update({
        where: { id },
        data: { status: 'ERROR' },
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to start application',
      } as ApiResponse);
    }
  } catch (error) {
    console.error('Error starting existing application:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Start application (with redeploy)
router.post('/:id/start', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    console.log('Start application request:', {
      params: req.params,
      url: req.url,
      method: req.method
    });

    const { id } = req.params || {};

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    // Get application
    const application = await prisma.application.findFirst({
      where: {
        id,
        ...(await orgScope(req)),
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    // A running app can be redeployed — the new release builds beside it and
    // takes over only once it answers. Two deploys at once is the thing to stop.
    if (application.status === 'DEPLOYING' || application.status === 'BUILDING' || deploymentService.isDeploying(id)) {
      return res.status(409).json({
        success: false,
        error: 'A deployment is already in progress',
      } as ApiResponse);
    }

    // Create deployment record
    const deployment = await prisma.deployment.create({
      data: {
        status: 'PENDING',
        applicationId: application.id,
        userId: req.user!.userId,
      },
    });

    // Update application status
    await prisma.application.update({
      where: { id },
      data: { status: 'DEPLOYING' },
    });

    // Heal the DNS record before the build runs — someone may have removed it,
    // and a deploy that finishes into a hostname that does not resolve is worse
    // than one that says so.
    const dns = await ensureAppHostname(application).catch(
      (error: any) => ({ state: 'unavailable' as const, detail: String(error?.message ?? 'DNS setup failed') }),
    );
    // does not fail the deploy — the hostname may be in a zone we do not run
    const dnsWarning =
      dns.state === 'conflict' || dns.state === 'unavailable' ? `DNS was not set up: ${dns.detail}\n\n` : '';

    // Start deployment in background
    deploymentService.deploy({
      application,
      deployment,
      envVars: application.envVars as Record<string, string> || {},
    }).then(async (result) => {
      // Update deployment record with logs
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: {
          status: result.success ? 'SUCCESS' : 'FAILED',
          buildLogs: result.buildLogs || '',
          deployLogs: dnsWarning + (result.deployLogs || ''),
        },
      });

      await prisma.application.update({
        where: { id },
        data: {
          status: result.success || result.rolledBack ? 'RUNNING' : 'ERROR',
          // only a deploy that left something running counts — the UI reads
          // lastDeployment as "has a build to start"
          ...(result.success && { lastDeployment: new Date() }),
        },
      });
    }).catch(async (error) => {
      console.error('Deployment failed:', error);

      // Update deployment record
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: {
          status: 'FAILED',
          buildLogs: error.message || 'Deployment failed',
        },
      });

      await prisma.application.update({
        where: { id },
        data: { status: 'ERROR' },
      });
    });

    return res.json({
      success: true,
      data: { deploymentId: deployment.id },
      message: 'Application deployment started',
    } as ApiResponse);
  } catch (error) {
    console.error('Error starting application:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Stop application
router.post('/:id/stop', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    // Get application
    const application = await prisma.application.findFirst({
      where: {
        id,
        ...(await orgScope(req)),
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    const pm2Handled = await handlePm2Action(application, 'stop', res);
    if (pm2Handled) return pm2Handled;

    if (application.status !== 'RUNNING') {
      return res.status(400).json({
        success: false,
        error: 'Application is not running',
      } as ApiResponse);
    }

    const stopped = await deploymentService.stopApplication(application.domain);

    if (stopped) {
      await prisma.application.update({
        where: { id },
        data: { status: 'STOPPED' },
      });

      return res.json({
        success: true,
        message: 'Application stopped successfully',
      } as ApiResponse);
    } else {
      return res.status(500).json({
        success: false,
        error: 'Failed to stop application',
      } as ApiResponse);
    }
  } catch (error) {
    console.error('Error stopping application:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Restart application
router.post('/:id/restart', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    // Get application
    const application = await prisma.application.findFirst({
      where: {
        id,
        ...(await orgScope(req)),
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    const pm2Handled = await handlePm2Action(application, 'restart', res);
    if (pm2Handled) return pm2Handled;
    // check if application is running
    const status = await deploymentService.getApplicationStatus(application.domain);
    if (status === 'STOPPED') {
      //update application status to running
      await prisma.application.update({
        where: { id },
        data: { status: 'STOPPED' },
      });
      return res.json({
        success: false,
        error: 'Application is not running',
      } as ApiResponse);
    }
    const restarted = await deploymentService.restartApplication(application.domain);

    if (restarted) {
      await prisma.application.update({
        where: { id },
        data: { status: 'RUNNING' },
      });

      return res.json({
        success: true,
        message: 'Application restarted successfully',
      } as ApiResponse);
    } else {
      return res.status(500).json({
        success: false,
        error: 'Failed to restart application',
      } as ApiResponse);
    }
  } catch (error) {
    console.error('Error restarting application:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// List releases for an application
/**
 * Is the hostname actually serving? Checked live rather than stored: DNS and
 * certificates change without anything telling us, and a cached answer would
 * be exactly the lie this is here to catch.
 */
router.get('/:id/hostname', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({
      where: { id: req.params.id as string, ...(await orgScope(req)) },
    });

    if (!application) {
      return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    }

    return res.json({ success: true, data: await checkAppHostname(application.domain) } as ApiResponse);
  } catch (error) {
    console.error('Error checking application hostname:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/** Create or repoint the app's DNS record. `force` overwrites a conflicting one. */
router.post('/:id/dns', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({
      where: { id: req.params.id as string, ...(await orgScope(req)) },
    });

    if (!application) {
      return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    }

    const result = await ensureAppHostname(application, { force: req.body?.force === true });

    return res.json({
      success: result.state !== 'conflict' && result.state !== 'unavailable',
      data: result,
      ...(result.state === 'conflict' || result.state === 'unavailable'
        ? { error: result.detail }
        : { message: result.detail }),
    } as ApiResponse);
  } catch (error: any) {
    console.error('Error setting application DNS:', error);
    return res.status(502).json({
      success: false,
      error: error?.message || 'Could not set up DNS for this hostname',
    } as ApiResponse);
  }
});

router.get('/:id/releases', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    const application = await prisma.application.findFirst({
      where: {
        id,
        ...(await orgScope(req)),
      },
      include: {
        activeRelease: true,
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    const releases = await prisma.release.findMany({
      where: {
        applicationId: application.id,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return res.json({
      success: true,
      data: {
        applicationId: application.id,
        activeReleaseId: application.activeReleaseId,
        releases,
      },
      message: 'Releases retrieved successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error fetching releases:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Activate a specific release (rollback)
router.post('/:id/releases/:releaseId/activate', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id, releaseId } = req.params;

    if (!id || !releaseId) {
      return res.status(400).json({
        success: false,
        error: 'Application ID and Release ID are required',
      } as ApiResponse);
    }

    const application = await prisma.application.findFirst({
      where: {
        id,
        ...(await orgScope(req)),
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    const release = await prisma.release.findFirst({
      where: {
        id: releaseId,
        applicationId: application.id,
      },
    });

    if (!release) {
      return res.status(404).json({
        success: false,
        error: 'Release not found',
      } as ApiResponse);
    }

    if (release.status !== 'READY') {
      return res.status(400).json({
        success: false,
        error: 'Release is not in READY state',
      } as ApiResponse);
    }

    await prisma.application.update({
      where: { id: application.id },
      data: { activeReleaseId: release.id },
    });

    await deploymentService.stopApplication(application.domain);

    const started = await deploymentService.startRelease(application, release);

    await prisma.application.update({
      where: { id: application.id },
      data: {
        status: started ? 'RUNNING' : 'ERROR',
        lastDeployment: new Date(),
      },
    });

    if (!started) {
      return res.status(500).json({
        success: false,
        error: 'Failed to start the selected release',
      } as ApiResponse);
    }

    return res.json({
      success: true,
      data: {
        applicationId: application.id,
        activeReleaseId: release.id,
      },
      message: 'Release activated successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error activating release:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

export default router; 
