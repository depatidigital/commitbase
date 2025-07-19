import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { 
  CreateApplicationSchema, 
  UpdateApplicationSchema, 
  ApiResponse,
  PaginatedResponse 
} from '../types';
import { validateRequest } from '../middleware/validation';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

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
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
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
    } as ApiResponse<PaginatedResponse<any>>);
  } catch (error) {
    console.error('Get applications error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Get single application
router.get('/:id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params as { id: string };

    const application = await prisma.application.findFirst({
      where: {
        id,
        userId: req.user!.userId,
      },
      include: {
        deployments: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        databases: true,
        logs: {
          orderBy: { timestamp: 'desc' },
          take: 50,
        },
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    res.json({
      success: true,
      data: application,
    } as ApiResponse);
  } catch (error) {
    console.error('Get application error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Create new application
router.post('/', authenticateToken, validateRequest(CreateApplicationSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const applicationData = req.body;

    // Check if domain is already taken
    const existingApp = await prisma.application.findUnique({
      where: { domain: applicationData.domain },
    });

    if (existingApp) {
      return res.status(400).json({
        success: false,
        error: 'Domain already in use',
      } as ApiResponse);
    }

    const application = await prisma.application.create({
      data: {
        ...applicationData,
        userId: req.user!.userId,
        envVars: applicationData.envVars || {},
      },
      include: {
        deployments: true,
        databases: true,
      },
    });

    res.status(201).json({
      success: true,
      data: application,
      message: 'Application created successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Create application error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Update application
router.put('/:id', authenticateToken, validateRequest(UpdateApplicationSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params as { id: string };
    const updateData = req.body;

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

    // If domain is being updated, check if it's available
    if (updateData.domain && updateData.domain !== existingApp.domain) {
      const domainExists = await prisma.application.findUnique({
        where: { domain: updateData.domain },
      });

      if (domainExists) {
        return res.status(400).json({
          success: false,
          error: 'Domain already in use',
        } as ApiResponse);
      }
    }

    const application = await prisma.application.update({
      where: { id },
      data: updateData,
      include: {
        deployments: true,
        databases: true,
      },
    });

    res.json({
      success: true,
      data: application,
      message: 'Application updated successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Update application error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Delete application
router.delete('/:id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params as { id: string };

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

    await prisma.application.delete({
      where: { id },
    });

    res.json({
      success: true,
      data: application,
      message: 'Application deleted successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Delete application error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Start application
router.post('/:id/start', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params as { id: string };

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

    // Update status to running
    await prisma.application.update({
      where: { id },
      data: { status: 'RUNNING' },
    });

    res.json({
      success: true,
      data: application,
      message: 'Application started successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Start application error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Stop application
router.post('/:id/stop', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params as { id: string };

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

    // Update status to stopped
    await prisma.application.update({
      where: { id },
      data: { status: 'STOPPED' },
    });

    res.json({
      success: true,
      data: application,
      message: 'Application stopped successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Stop application error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

export default router; 