import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { CreateApplicationSchema, UpdateApplicationSchema, ApiResponse, Application, PaginatedResponse } from '../types';
import { validateRequest } from '../middleware/validation';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { DeploymentService, getDockerContainerName } from '../services/deployment';
import { getStaticSiteBaseUrl } from '../services/s3Service';

const router = Router();
const deploymentService = new DeploymentService();

// Get all applications for the authenticated user
router.get('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;

    const [applications, total] = await Promise.all([
      prisma.application.findMany({
        where: {
          userId: req.user!.userId,
        },
        include: {
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
      prisma.application.count({
        where: {
          userId: req.user!.userId,
        },
      }),
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
        userId: req.user!.userId,
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

    const staticSiteUrl = application.type === 'STATIC' ? getStaticSiteBaseUrl(application.id) : undefined;

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
    const { name, domain, type, repository, branch, buildCommand, startCommand, port, envVars } = req.body;

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
        userId: req.user!.userId,
      },
    });

    if (!existingApp) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    // Check if new domain conflicts with existing application
    if (domain && domain !== existingApp.domain) {
      const domainConflict = await prisma.application.findUnique({
        where: { domain },
      });

      if (domainConflict) {
        return res.status(400).json({
          success: false,
          error: 'Domain already in use',
        } as ApiResponse);
      }
    }

    // Update application
    const updatedApp = await prisma.application.update({
      where: { id },
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
        userId: req.user!.userId,
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
        userId: req.user!.userId,
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

    await prisma.application.update({
      where: { id },
      data: { status: 'DEPLOYING' },
    });

    // Start existing container without redeploying
    const started = await deploymentService.startDockerCompose(application.domain);

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
        userId: req.user!.userId,
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
        userId: req.user!.userId,
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    if (application.status !== 'RUNNING') {
      return res.status(400).json({
        success: false,
        error: 'Application is not running',
      } as ApiResponse);
    }

    // Stop PM2 process
    const containerName = getDockerContainerName(application);
    const stopped = await deploymentService.stopApplication(containerName);

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
        userId: req.user!.userId,
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }
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
    // Restart PM2 process
    const containerName = getDockerContainerName(application);
    const restarted = await deploymentService.restartApplication(containerName);

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
        userId: req.user!.userId,
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
        userId: req.user!.userId,
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

    const containerName = getDockerContainerName(application);
    await deploymentService.stopApplication(containerName);

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
        error: 'Failed to start container for selected release',
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
