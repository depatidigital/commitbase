import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { CreateApplicationSchema, UpdateApplicationSchema, ApiResponse, Application, PaginatedResponse } from '../types';
import { validateRequest } from '../middleware/validation';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { paging, contains } from '../lib/paging';
import { orgScope, resolveOwnedDomain } from '../lib/scope';
import { DeploymentService } from '../services/deployment';
import { getStaticSiteBaseUrl } from '../services/s3Service';
import { ensureSiteBucket, uploadSiteObject } from '../services/r2Service';
import { configureCaddyForStaticApplication } from '../services/caddyService';
import { syncServerApps, scanServerApps, controlPm2Process } from '../services/appSyncService';
import { requireRole } from '../middleware/auth';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';

const router = Router();
const deploymentService = new DeploymentService();

/**
 * Apps discovered by the server sync are owned by pm2, not by our systemd
 * deployer, so start/stop/restart route to pm2 for them. Returns null when the
 * app is not pm2-managed and the caller should fall through to systemd.
 */
async function handlePm2Action(
  application: { id: string; runtime: string | null; processName: string | null },
  action: 'start' | 'stop' | 'restart',
  res: Response
): Promise<Response | null> {
  if (application.runtime !== 'PM2' || !application.processName) {
    return null;
  }

  const result = await controlPm2Process(application.processName, action);

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
router.get('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, limit, skip, search, organizationId } = paging(req);
    const where = {
      ...(await orgScope(req)),
      ...(organizationId && { organizationId }),
      ...(search && { OR: [{ name: contains(search) }, { domain: contains(search) }] }),
    };

    const [applications, total] = await Promise.all([
      prisma.application.findMany({
        where,
        include: {
          organization: { select: { id: true, name: true, slug: true } },
          deployments: {
            orderBy: {
              createdAt: 'desc',
            },
            take: 1,
          },
        },
        skip,
        take: limit,
        orderBy: {
          createdAt: 'desc',
        },
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
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    const staticSiteUrl =
      application.type === 'STATIC'
        ? (application as any).staticOrigin
          ? `https://${application.domain}`
          : getStaticSiteBaseUrl(application.id)
        : undefined;

    return res.json({
      success: true,
      data: {
        ...application,
        staticSiteUrl,
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
    const { name, type, repository, branch, buildCommand, startCommand, port, envVars } = req.body;
    const domain = String(req.body.domain || '').trim().toLowerCase();

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

    return res.status(201).json({
      success: true,
      data: application,
      message: 'Application created successfully',
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
        let bucket: string;
        let origin: string;

        try {
          ({ bucket, origin } = await ensureSiteBucket(application.domain));
        } catch (error: any) {
          return res.status(500).json({
            success: false,
            error: error?.message || 'Could not prepare the site bucket',
          } as ApiResponse);
        }

        let uploaded = 0;
        for (const [index, file] of files.entries()) {
          const relative = safeRelativePath(paths[index] || file.originalname);
          if (!relative) continue;

          await uploadSiteObject(bucket, relative, file.buffer);
          uploaded += 1;
        }

        if (uploaded === 0) {
          return res.status(400).json({ success: false, error: 'No usable files in the upload' } as ApiResponse);
        }

        await prisma.application.update({
          where: { id: application.id },
          data: {
            status: 'RUNNING',
            lastDeployment: new Date(),
            staticBucket: bucket,
            staticOrigin: origin,
          },
        });

        await configureCaddyForStaticApplication(application.id, application.domain, origin).catch(() => {});

        return res.json({
          success: true,
          data: { files: uploaded },
          message: 'Static files uploaded to Cloudflare R2',
        } as ApiResponse);
      }

      const appDir = await deploymentService.prepareAppDirectory(application.id);
      const sourcesDir = path.join(appDir, 'sources');

      // a fresh upload replaces the previous one — leftovers would ship in the build
      await fs.rm(sourcesDir, { recursive: true, force: true });
      await fs.mkdir(sourcesDir, { recursive: true });

      let written = 0;
      for (const [index, file] of files.entries()) {
        const relative = safeRelativePath(paths[index] || file.originalname);
        if (!relative) continue;

        const target = path.join(sourcesDir, relative);
        if (!target.startsWith(sourcesDir + path.sep)) continue;

        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, file.buffer);
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

// Update an application
router.put('/:id', authenticateToken, validateRequest(UpdateApplicationSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    console.log('Update application request:', {
      params: req.params,
      body: req.body,
      url: req.url,
      method: req.method
    });

    const { id } = req.params || {};
    const { name, domain, type, repository, branch, buildCommand, startCommand, port, envVars } = req.body || {};
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
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    // Stop the application if it's running
    if (application.status === 'RUNNING') {
      // TODO: Implement proper process management
      console.log(`Stopping application: ${application.name}`);
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

    if (application.status === 'RUNNING') {
      return res.status(400).json({
        success: false,
        error: 'Application is already running',
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
          deployLogs: result.deployLogs || '',
        },
      });

      await prisma.application.update({
        where: { id },
        data: {
          status: result.success ? 'RUNNING' : 'ERROR',
          lastDeployment: new Date(),
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
