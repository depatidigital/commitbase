import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { CreateDeploymentSchema, ApiResponse } from '../types';
import { validateRequest } from '../middleware/validation';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// Get deployments for an application
router.get('/application/:appId', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { appId } = req.params;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;

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

    const [deployments, total] = await Promise.all([
      prisma.deployment.findMany({
        where: {
          applicationId: appId,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.deployment.count({
        where: {
          applicationId: appId,
        },
      }),
    ]);

    const totalPages = Math.ceil(total / limit);

    res.json({
      success: true,
      data: {
        data: deployments,
        pagination: {
          page,
          limit,
          total,
          totalPages,
        },
      },
    } as ApiResponse);
  } catch (error) {
    console.error('Get deployments error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Get single deployment
router.get('/:id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    const deployment = await prisma.deployment.findFirst({
      where: {
        id,
        user: {
          id: req.user!.userId,
        },
      },
      include: {
        application: true,
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
    } as ApiResponse);
  } catch (error) {
    console.error('Get deployment error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Create new deployment
router.post('/', authenticateToken, validateRequest(CreateDeploymentSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { applicationId, envVars } = req.body;

    // Verify application belongs to user
    const application = await prisma.application.findFirst({
      where: {
        id: applicationId,
        userId: req.user!.userId,
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    // Create deployment
    const deployment = await prisma.deployment.create({
      data: {
        applicationId,
        userId: req.user!.userId,
        status: 'PENDING',
        envVars: envVars || {},
      },
      include: {
        application: true,
      },
    });

    // Update application deployment count
    await prisma.application.update({
      where: { id: applicationId },
      data: {
        deploymentCount: {
          increment: 1,
        },
        lastDeployment: new Date(),
      },
    });

    res.status(201).json({
      success: true,
      data: deployment,
      message: 'Deployment created successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Create deployment error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Cancel deployment
router.post('/:id/cancel', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    const deployment = await prisma.deployment.findFirst({
      where: {
        id,
        userId: req.user!.userId,
      },
    });

    if (!deployment) {
      return res.status(404).json({
        success: false,
        error: 'Deployment not found',
      } as ApiResponse);
    }

    if (deployment.status === 'SUCCESS' || deployment.status === 'FAILED') {
      return res.status(400).json({
        success: false,
        error: 'Cannot cancel completed deployment',
      } as ApiResponse);
    }

    await prisma.deployment.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });

    res.json({
      success: true,
      message: 'Deployment cancelled successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Cancel deployment error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

export default router; 