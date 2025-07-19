import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ApiResponse } from '../types';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// Get logs for an application
router.get('/application/:appId', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { appId } = req.params;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const skip = (page - 1) * limit;
    const level = req.query.level as string;

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

    const whereClause: any = {
      applicationId: appId,
    };

    if (level) {
      whereClause.level = level;
    }

    const [logs, total] = await Promise.all([
      prisma.log.findMany({
        where: whereClause,
        orderBy: { timestamp: 'desc' },
        skip,
        take: limit,
      }),
      prisma.log.count({
        where: whereClause,
      }),
    ]);

    const totalPages = Math.ceil(total / limit);

    res.json({
      success: true,
      data: {
        data: logs,
        pagination: {
          page,
          limit,
          total,
          totalPages,
        },
      },
    } as ApiResponse);
  } catch (error) {
    console.error('Get logs error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Get system logs
router.get('/system', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const skip = (page - 1) * limit;
    const level = req.query.level as string;

    const whereClause: any = {
      applicationId: null,
    };

    if (level) {
      whereClause.level = level;
    }

    const [logs, total] = await Promise.all([
      prisma.log.findMany({
        where: whereClause,
        orderBy: { timestamp: 'desc' },
        skip,
        take: limit,
      }),
      prisma.log.count({
        where: whereClause,
      }),
    ]);

    const totalPages = Math.ceil(total / limit);

    res.json({
      success: true,
      data: {
        data: logs,
        pagination: {
          page,
          limit,
          total,
          totalPages,
        },
      },
    } as ApiResponse);
  } catch (error) {
    console.error('Get system logs error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Create log entry
router.post('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { level, message, applicationId, metadata } = req.body;

    const log = await prisma.log.create({
      data: {
        level,
        message,
        applicationId,
        metadata: metadata || {},
        userId: req.user!.userId,
      },
    });

    res.status(201).json({
      success: true,
      data: log,
      message: 'Log created successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Create log error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

export default router; 