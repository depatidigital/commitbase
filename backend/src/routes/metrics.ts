import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ApiResponse } from '../types';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// Get system metrics
router.get('/system', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { type, startDate, endDate } = req.query;
    const limit = parseInt(req.query.limit as string) || 100;

    const whereClause: any = {};

    if (type) {
      whereClause.type = type;
    }

    if (startDate && endDate) {
      whereClause.timestamp = {
        gte: new Date(startDate as string),
        lte: new Date(endDate as string),
      };
    }

    const metrics = await prisma.systemMetric.findMany({
      where: whereClause,
      orderBy: { timestamp: 'desc' },
      take: limit,
    });

    res.json({
      success: true,
      data: metrics,
    } as ApiResponse);
  } catch (error) {
    console.error('Get system metrics error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Get application metrics
router.get('/application/:appId', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { appId } = req.params;
    const { startDate, endDate } = req.query;
    const limit = parseInt(req.query.limit as string) || 100;

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

    if (startDate && endDate) {
      whereClause.timestamp = {
        gte: new Date(startDate as string),
        lte: new Date(endDate as string),
      };
    }

    const metrics = await prisma.systemMetric.findMany({
      where: whereClause,
      orderBy: { timestamp: 'desc' },
      take: limit,
    });

    res.json({
      success: true,
      data: metrics,
    } as ApiResponse);
  } catch (error) {
    console.error('Get application metrics error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Create metric entry
router.post('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { type, value, unit, metadata, applicationId } = req.body;

    const metric = await prisma.systemMetric.create({
      data: {
        type,
        value,
        unit,
        metadata: metadata || {},
        applicationId,
      },
    });

    res.status(201).json({
      success: true,
      data: metric,
      message: 'Metric created successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Create metric error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

export default router; 