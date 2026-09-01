import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ApiResponse } from '../types';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { orgScope } from '../lib/scope';
import { DeploymentService } from '../services/deployment';
import { getBuildLogPresignedUrl, getBuildLogKey, downloadObjectToString } from '../services/s3Service';

const router = Router();
const deploymentService = new DeploymentService();

// Get deployment history for an application
router.get('/application/:appId', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { appId } = req.params;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;

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

    const skip = (page - 1) * limit;
    const deployments = await prisma.deployment.findMany({
      where: {
        applicationId: appId,
      },
      orderBy: {
        createdAt: 'desc',
      },
      skip,
      take: limit,
      include: {
        application: {
          select: {
            id: true,
            name: true,
            domain: true,
          },
        },
      },
    });

    const total = await prisma.deployment.count({
      where: {
        applicationId: appId,
      },
    });

    return res.json({
      success: true,
      data: {
        deployments,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      },
      message: 'Deployment history retrieved successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error fetching deployment history:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Get specific deployment by ID
router.get('/:deploymentId', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { deploymentId } = req.params;

    if (!deploymentId) {
      return res.status(400).json({
        success: false,
        error: 'Deployment ID is required',
      } as ApiResponse);
    }

    const deployment = await prisma.deployment.findFirst({
      where: {
        id: deploymentId,
        application: {
          ...(await orgScope(req)),
        },
      },
      include: {
        application: {
          select: {
            id: true,
            name: true,
            domain: true,
          },
        },
      },
    });

    if (!deployment) {
      return res.status(404).json({
        success: false,
        error: 'Deployment not found',
      } as ApiResponse);
    }

    return res.json({
      success: true,
      data: deployment,
      message: 'Deployment retrieved successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error fetching deployment:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Get build log URL for a deployment
router.get('/:deploymentId/build-log-url', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { deploymentId } = req.params;

    if (!deploymentId) {
      return res.status(400).json({
        success: false,
        error: 'Deployment ID is required',
      } as ApiResponse);
    }

    const deployment = await prisma.deployment.findFirst({
      where: {
        id: deploymentId,
        application: {
          ...(await orgScope(req)),
        },
      },
      select: {
        id: true,
        applicationId: true,
      },
    });

    if (!deployment) {
      return res.status(404).json({
        success: false,
        error: 'Deployment not found',
      } as ApiResponse);
    }

    const url = await getBuildLogPresignedUrl(deployment.applicationId, deployment.id);

    if (!url) {
      return res.status(500).json({
        success: false,
        error: 'Build log URL is not available (S3 not configured)',
      } as ApiResponse);
    }

    return res.json({
      success: true,
      data: {
        url,
      },
      message: 'Build log URL retrieved successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error fetching build log URL:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Get deployment logs by deployment ID
router.get('/:deploymentId/logs', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { deploymentId } = req.params;
    const logType = (req.query.type as string) || 'build'; // build, start, combined
    const lines = parseInt(req.query.lines as string) || 100;

    if (!deploymentId) {
      return res.status(400).json({
        success: false,
        error: 'Deployment ID is required',
      } as ApiResponse);
    }

    const deployment = await prisma.deployment.findFirst({
      where: {
        id: deploymentId,
        application: {
          ...(await orgScope(req)),
        },
      },
      include: {
        application: {
          select: {
            domain: true,
          },
        },
      },
    });

    if (!deployment) {
      return res.status(404).json({
        success: false,
        error: 'Deployment not found',
      } as ApiResponse);
    }

    let logs = '';
    try {
      if (logType === 'build') {
        const key = getBuildLogKey(deployment.applicationId, deployment.id);

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
      } else {
        logs = await deploymentService.getApplicationLogs(deployment.application.domain, lines);
      }
    } catch (error) {
      logs = `No logs available for ${logType}`;
    }

    return res.json({
      success: true,
      data: {
        logs,
        deploymentId,
        logType,
        lines,
      },
      message: 'Deployment logs retrieved successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error fetching deployment logs:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Create a new deployment record
router.post('/application/:appId', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { appId } = req.params;
    const { status = 'PENDING', buildLogs = '', deployLogs = '' } = req.body;

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

    const deployment = await prisma.deployment.create({
      data: {
        applicationId: appId,
        userId: req.user!.userId,
        status,
        buildLogs,
        deployLogs,
      },
      include: {
        application: {
          select: {
            id: true,
            name: true,
            domain: true,
          },
        },
      },
    });

    return res.json({
      success: true,
      data: deployment,
      message: 'Deployment created successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error creating deployment:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Update deployment status
router.put('/:deploymentId', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { deploymentId } = req.params;
    const { status, buildLogs, deployLogs } = req.body;

    if (!deploymentId) {
      return res.status(400).json({
        success: false,
        error: 'Deployment ID is required',
      } as ApiResponse);
    }

    // Verify deployment belongs to user's application
    const existingDeployment = await prisma.deployment.findFirst({
      where: {
        id: deploymentId,
        application: {
          ...(await orgScope(req)),
        },
      },
    });

    if (!existingDeployment) {
      return res.status(404).json({
        success: false,
        error: 'Deployment not found',
      } as ApiResponse);
    }

    const deployment = await prisma.deployment.update({
      where: {
        id: deploymentId,
      },
      data: {
        status,
        buildLogs,
        deployLogs,
      },
      include: {
        application: {
          select: {
            id: true,
            name: true,
            domain: true,
          },
        },
      },
    });

    return res.json({
      success: true,
      data: deployment,
      message: 'Deployment updated successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error updating deployment:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Clear deployment logs
router.delete('/:deploymentId/logs', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { deploymentId } = req.params;

    if (!deploymentId) {
      return res.status(400).json({
        success: false,
        error: 'Deployment ID is required',
      } as ApiResponse);
    }

    // Verify deployment belongs to user's application
    const deployment = await prisma.deployment.findFirst({
      where: {
        id: deploymentId,
        application: {
          ...(await orgScope(req)),
        },
      },
    });

    if (!deployment) {
      return res.status(404).json({
        success: false,
        error: 'Deployment not found',
      } as ApiResponse);
    }

    const success = await deploymentService.clearDeploymentLogs(deploymentId);

    if (success) {
      return res.json({
        success: true,
        message: 'Deployment logs cleared successfully',
      } as ApiResponse);
    }

    return res.status(500).json({
      success: false,
      error: 'Failed to clear deployment logs',
    } as ApiResponse);
  } catch (error) {
    console.error('Error clearing deployment logs:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Delete deployment
router.delete('/:deploymentId', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { deploymentId } = req.params;

    if (!deploymentId) {
      return res.status(400).json({
        success: false,
        error: 'Deployment ID is required',
      } as ApiResponse);
    }

    // Verify deployment belongs to user's application
    const deployment = await prisma.deployment.findFirst({
      where: {
        id: deploymentId,
        application: {
          ...(await orgScope(req)),
        },
      },
    });

    if (!deployment) {
      return res.status(404).json({
        success: false,
        error: 'Deployment not found',
      } as ApiResponse);
    }

    await prisma.deployment.delete({
      where: {
        id: deploymentId,
      },
    });

    return res.json({
      success: true,
      message: 'Deployment deleted successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error deleting deployment:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

export default router; 
