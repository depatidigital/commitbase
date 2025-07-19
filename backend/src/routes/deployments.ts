import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ApiResponse } from '../types';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { DeploymentService } from '../services/deployment';

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
        userId: req.user!.userId,
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    // Get deployment history with pagination
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

    // Get total count for pagination
    const total = await prisma.deployment.count({
      where: {
        applicationId: appId,
      },
    });

    res.json({
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
    res.status(500).json({
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

    // Get deployment with application info
    const deployment = await prisma.deployment.findFirst({
      where: {
        id: deploymentId,
        application: {
          userId: req.user!.userId,
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

    res.json({
      success: true,
      data: deployment,
      message: 'Deployment retrieved successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error fetching deployment:', error);
    res.status(500).json({
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

    // Verify deployment belongs to user's application
    const deployment = await prisma.deployment.findFirst({
      where: {
        id: deploymentId,
        application: {
          userId: req.user!.userId,
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

    // Get logs based on type
    let logs = '';
    try {
      if (logType === 'build') {
        // For build logs, use file-based logs with deployment ID
        logs = await deploymentService.getDeploymentLogs(deploymentId, logType, lines);
      } else {
        // For runtime logs, use Docker logs
        logs = await deploymentService.getDockerComposeLogs(deployment.application.domain, undefined, lines);
      }
    } catch (error) {
      logs = `No logs available for ${logType}`;
    }

    res.json({
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
    res.status(500).json({
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
        userId: req.user!.userId,
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    // Create deployment record
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

    res.json({
      success: true,
      data: deployment,
      message: 'Deployment created successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error creating deployment:', error);
    res.status(500).json({
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
          userId: req.user!.userId,
        },
      },
    });

    if (!existingDeployment) {
      return res.status(404).json({
        success: false,
        error: 'Deployment not found',
      } as ApiResponse);
    }

    // Update deployment
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

    res.json({
      success: true,
      data: deployment,
      message: 'Deployment updated successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error updating deployment:', error);
    res.status(500).json({
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
          userId: req.user!.userId,
        },
      },
    });

    if (!deployment) {
      return res.status(404).json({
        success: false,
        error: 'Deployment not found',
      } as ApiResponse);
    }

    // Clear deployment logs
    const success = await deploymentService.clearDeploymentLogs(deploymentId);

    if (success) {
      res.json({
        success: true,
        message: 'Deployment logs cleared successfully',
      } as ApiResponse);
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to clear deployment logs',
      } as ApiResponse);
    }
  } catch (error) {
    console.error('Error clearing deployment logs:', error);
    res.status(500).json({
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
          userId: req.user!.userId,
        },
      },
    });

    if (!deployment) {
      return res.status(404).json({
        success: false,
        error: 'Deployment not found',
      } as ApiResponse);
    }

    // Delete deployment
    await prisma.deployment.delete({
      where: {
        id: deploymentId,
      },
    });

    res.json({
      success: true,
      message: 'Deployment deleted successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error deleting deployment:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

export default router; 