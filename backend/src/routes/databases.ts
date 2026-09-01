import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { CreateDatabaseSchema, ApiResponse } from '../types';
import { validateRequest } from '../middleware/validation';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { orgScope } from '../lib/scope';

const router = Router();

// Get databases for an application
// All databases across the caller's organizations
router.get('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const databases = await prisma.database.findMany({
      where: {
        application: { ...(await orgScope(req)) },
      },
      include: {
        application: { select: { id: true, name: true, domain: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ success: true, data: databases } as ApiResponse);
  } catch (error) {
    console.error('List databases error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

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
        ...(await orgScope(req)),
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    const databases = await prisma.database.findMany({
      where: {
        applicationId: appId,
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({
      success: true,
      data: databases,
    } as ApiResponse);
  } catch (error) {
    console.error('Get databases error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Get single database
router.get('/:id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Database ID is required',
      } as ApiResponse);
    }

    const database = await prisma.database.findFirst({
      where: {
        id: id as string,
        application: {
          ...(await orgScope(req)),
        },
      },
      include: {
        application: true,
      },
    });

    if (!database) {
      return res.status(404).json({
        success: false,
        error: 'Database not found',
      } as ApiResponse);
    }

    return res.json({
      success: true,
      data: database,
    } as ApiResponse);
  } catch (error) {
    console.error('Get database error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Create new database
router.post('/', authenticateToken, validateRequest(CreateDatabaseSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, type, version, config, applicationId } = req.body as {
      name: string;
      type: string;
      version?: string;
      config?: Record<string, unknown>;
      applicationId: string;
    };

    if (!applicationId) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    // Verify application belongs to user
    const application = await prisma.application.findFirst({
      where: {
        id: applicationId,
        ...(await orgScope(req)),
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    // Generate connection string based on type
    let connectionString = '';
    let port = 0;

    switch (type) {
      case 'POSTGRESQL':
        port = 5432;
        connectionString = `postgresql://user:password@localhost:${port}/${name}`;
        break;
      case 'MYSQL':
        port = 3306;
        connectionString = `mysql://user:password@localhost:${port}/${name}`;
        break;
      case 'MONGODB':
        port = 27017;
        connectionString = `mongodb://localhost:${port}/${name}`;
        break;
      case 'REDIS':
        port = 6379;
        connectionString = `redis://localhost:${port}`;
        break;
      default:
        connectionString = '';
    }

    const database = await prisma.database.create({
      data: {
        name,
        type,
        version,
        config: config || {},
        connectionString,
        port,
        applicationId,
        status: 'CREATING',
      } as any,
      include: {
        application: true,
      },
    });

    return res.status(201).json({
      success: true,
      data: database,
      message: 'Database created successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Create database error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Delete database
router.delete('/:id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Database ID is required',
      } as ApiResponse);
    }

    const database = await prisma.database.findFirst({
      where: {
        id: id as string,
        application: {
          ...(await orgScope(req)),
        },
      },
    });

    if (!database) {
      return res.status(404).json({
        success: false,
        error: 'Database not found',
      } as ApiResponse);
    }

    await prisma.database.delete({
      where: { id: id as string },
    });

    return res.json({
      success: true,
      message: 'Database deleted successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Delete database error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

export default router; 
