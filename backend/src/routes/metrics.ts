import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ApiResponse } from '../types';
import { authenticateToken, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { orgScope } from '../lib/scope';

const router = Router();

// Get system metrics — host-wide, admin only
router.get('/system', authenticateToken, requireRole(['ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
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

    if (!appId) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

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

    const whereClause: {
      applicationId: string;
      timestamp?: {
        gte: Date;
        lte: Date;
      };
    } = {
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

    return res.json({
      success: true,
      data: metrics,
    } as ApiResponse);
  } catch (error) {
    console.error('Get application metrics error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Create metric entry — written by platform internals, not clients
router.post('/', authenticateToken, requireRole(['ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { type, value, unit, metadata, applicationId } = req.body as {
      type: string;
      value: number;
      unit?: string;
      metadata?: Record<string, unknown>;
      applicationId: string;
    };

    if (!applicationId) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    const metric = await prisma.systemMetric.create({
      data: {
        type: type as any,
        value,
        unit,
        metadata: (metadata || {}) as any,
        applicationId,
      } as any,
    });

    return res.status(201).json({
      success: true,
      data: metric,
      message: 'Metric created successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Create metric error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

export default router; 
