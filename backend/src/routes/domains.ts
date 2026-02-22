import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { CreateDomainSchema, UpdateDomainSchema, ApiResponse, Domain } from '../types';
import { validateRequest } from '../middleware/validation';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// Get all domains for the authenticated user
router.get('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const domains = await prisma.domain.findMany({
      where: {
        userId: req.user!.userId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    res.json({
      success: true,
      data: domains,
      message: 'Domains retrieved successfully',
    } as ApiResponse<Domain[]>);
  } catch (error) {
    console.error('Error fetching domains:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Get a specific domain by ID
router.get('/:id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Domain ID is required',
      } as ApiResponse);
    }

    const domain = await prisma.domain.findFirst({
      where: {
        id: id as string,
        userId: req.user!.userId,
      },
    });

    if (!domain) {
      return res.status(404).json({
        success: false,
        error: 'Domain not found',
      } as ApiResponse);
    }

    return res.json({
      success: true,
      data: domain,
      message: 'Domain retrieved successfully',
    } as ApiResponse<Domain>);
  } catch (error) {
    console.error('Error fetching domain:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Create a new domain
router.post('/', authenticateToken, validateRequest(CreateDomainSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, redirectTo, customConfig } = req.body;

    // Check if domain already exists
    const existingDomain = await prisma.domain.findUnique({
      where: { name },
    });

    if (existingDomain) {
      return res.status(400).json({
        success: false,
        error: 'Domain already exists',
      } as ApiResponse);
    }

    const domain = await prisma.domain.create({
      data: {
        name,
        redirectTo,
        customConfig,
        userId: req.user!.userId,
      },
    });

    return res.status(201).json({
      success: true,
      data: domain,
      message: 'Domain created successfully',
    } as ApiResponse<Domain>);
  } catch (error) {
    console.error('Error creating domain:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Update a domain
router.put('/:id', authenticateToken, validateRequest(UpdateDomainSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { name, status, redirectTo, customConfig } = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Domain ID is required',
      } as ApiResponse);
    }

    const existingDomain = await prisma.domain.findFirst({
      where: {
        id: id as string,
        userId: req.user!.userId,
      },
    });

    if (!existingDomain) {
      return res.status(404).json({
        success: false,
        error: 'Domain not found',
      } as ApiResponse);
    }

    // Check if new name conflicts with existing domain
    if (name && name !== existingDomain.name) {
      const nameConflict = await prisma.domain.findUnique({
        where: { name },
      });

      if (nameConflict) {
        return res.status(400).json({
          success: false,
          error: 'Domain name already exists',
        } as ApiResponse);
      }
    }

    const updatedDomain = await prisma.domain.update({
      where: { id: existingDomain.id },
      data: {
        name,
        status,
        redirectTo,
        customConfig,
      },
    });

    return res.json({
      success: true,
      data: updatedDomain,
      message: 'Domain updated successfully',
    } as ApiResponse<Domain>);
  } catch (error) {
    console.error('Error updating domain:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Delete a domain
router.delete('/:id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Domain ID is required',
      } as ApiResponse);
    }

    const domain = await prisma.domain.findFirst({
      where: {
        id: id as string,
        userId: req.user!.userId,
      },
    });

    if (!domain) {
      return res.status(404).json({
        success: false,
        error: 'Domain not found',
      } as ApiResponse);
    }

    // Delete domain
    await prisma.domain.delete({
      where: { id: domain.id },
    });

    return res.json({
      success: true,
      message: 'Domain deleted successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error deleting domain:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Verify domain DNS
router.post('/:id/verify', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Domain ID is required',
      } as ApiResponse);
    }

    const domain = await prisma.domain.findFirst({
      where: {
        id: id as string,
        userId: req.user!.userId,
      },
    });

    if (!domain) {
      return res.status(404).json({
        success: false,
        error: 'Domain not found',
      } as ApiResponse);
    }

    // TODO: Implement actual DNS verification logic
    // For now, return a mock response
    const dnsRecords = {
      a: '192.168.1.1',
      cname: 'app.commitbase.com',
      mx: 'mail.commitbase.com',
    };

    const updatedDomain = await prisma.domain.update({
      where: { id: domain.id },
      data: {
        dnsRecords,
        status: 'ACTIVE',
      },
    });

    return res.json({
      success: true,
      data: {
        domain: updatedDomain,
        dnsRecords,
        verified: true,
      },
      message: 'Domain DNS verified successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error verifying domain:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Renew SSL certificate
router.post('/:id/ssl/renew', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Domain ID is required',
      } as ApiResponse);
    }

    const domain = await prisma.domain.findFirst({
      where: {
        id: id as string,
        userId: req.user!.userId,
      },
    });

    if (!domain) {
      return res.status(404).json({
        success: false,
        error: 'Domain not found',
      } as ApiResponse);
    }

    // TODO: Implement actual SSL renewal logic
    // For now, return a mock response
    const sslExpiry = new Date();
    sslExpiry.setFullYear(sslExpiry.getFullYear() + 1);

    const updatedDomain = await prisma.domain.update({
      where: { id: domain.id },
      data: {
        sslStatus: 'ACTIVE',
        sslExpiry,
      },
    });

    return res.json({
      success: true,
      data: updatedDomain,
      message: 'SSL certificate renewed successfully',
    } as ApiResponse<Domain>);
  } catch (error) {
    console.error('Error renewing SSL:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

export default router; 
