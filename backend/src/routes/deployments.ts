import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ApiResponse } from '../types';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// Get deployments for an application
router.get('/application/:appId', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
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
        userId: req.user!.userId,
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    // Get deployments
    const deployments = await prisma.deployment.findMany({
      where: {
        applicationId: appId,
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 10,
    });

    res.json({
      success: true,
      data: deployments,
      message: 'Deployments retrieved successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error fetching deployments:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Get a specific deployment
router.get('/:id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Deployment ID is required',
      } as ApiResponse);
    }

    const deployment = await prisma.deployment.findFirst({
      where: {
        id,
        userId: req.user!.userId,
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

export default router; 