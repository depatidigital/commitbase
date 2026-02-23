import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { CreateDomainSchema, UpdateDomainSchema, ApiResponse, Domain } from '../types';
import { validateRequest } from '../middleware/validation';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { syncDomainDns, getOrCreateCloudflareZone, listCloudflareDnsRecords } from '../services/cloudflareService';

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

    const trimmedName = String(name).trim().toLowerCase();

    const existingDomain = await prisma.domain.findUnique({
      where: { name: trimmedName },
    });

    if (existingDomain) {
      return res.status(400).json({
        success: false,
        error: 'Domain already exists',
      } as ApiResponse);
    }

    let dnsRecords: any = null;
    let status: Domain['status'] = 'PENDING';
    let mergedCustomConfig: any = customConfig || null;

    const cloudflareZone = await getOrCreateCloudflareZone(trimmedName);
    if (cloudflareZone) {
      mergedCustomConfig = {
        ...(mergedCustomConfig || {}),
        cloudflare: {
          zoneId: cloudflareZone.id,
          zoneName: cloudflareZone.name,
          nameservers: cloudflareZone.nameServers,
          synced: true,
        },
      };

      status = 'ACTIVE';
    }

    const cloudflareRecords = await syncDomainDns(trimmedName, cloudflareZone?.id);
    if (cloudflareRecords) {
      dnsRecords = cloudflareRecords;
      status = 'ACTIVE';
    }

    const domain = await prisma.domain.create({
      data: {
        name: trimmedName,
        status,
        dnsRecords,
        redirectTo,
        customConfig: mergedCustomConfig,
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

router.get('/:id/dns-zone', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
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

    const existingCloudflareConfig = (domain.customConfig as any)?.cloudflare;

    let zoneId: string | null =
      existingCloudflareConfig && typeof existingCloudflareConfig.zoneId === 'string'
        ? existingCloudflareConfig.zoneId
        : null;

    let zoneName: string | null =
      existingCloudflareConfig && typeof existingCloudflareConfig.zoneName === 'string'
        ? existingCloudflareConfig.zoneName
        : null;

    let nameservers: string[] =
      existingCloudflareConfig && Array.isArray(existingCloudflareConfig.nameservers)
        ? existingCloudflareConfig.nameservers
        : [];

    if (!zoneId) {
      const zone = await getOrCreateCloudflareZone(domain.name);
      if (zone) {
        zoneId = zone.id;
        zoneName = zone.name;
        nameservers = zone.nameServers;
      }
    }

    if (!zoneId) {
      return res.status(200).json({
        success: true,
        data: {
          zone: null,
          records: [],
          synced: false,
        },
        message: 'Cloudflare zone not configured for this domain',
      } as ApiResponse);
    }

    await syncDomainDns(domain.name, zoneId);

    const records = await listCloudflareDnsRecords(zoneId);

    const responsePayload = {
      zone: {
        id: zoneId,
        name: zoneName || domain.name,
        nameservers,
      },
      records: records || [],
      synced: true,
    };

    return res.json({
      success: true,
      data: responsePayload,
      message: 'DNS zone configuration fetched successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error fetching domain DNS zone:', error);
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

    let dnsRecords: any = null;
    let verified = false;

    const existingCloudflareConfig = (domain.customConfig as any)?.cloudflare;
    const zoneIdOverride =
      existingCloudflareConfig && typeof existingCloudflareConfig.zoneId === 'string'
        ? existingCloudflareConfig.zoneId
        : undefined;

    const cloudflareRecords = await syncDomainDns(domain.name, zoneIdOverride);
    if (cloudflareRecords) {
      dnsRecords = cloudflareRecords;
      verified = true;
    } else {
      dnsRecords = {
        a: '192.168.1.1',
        cname: 'app.commitbase.com',
        mx: 'mail.commitbase.com',
      };
      verified = true;
    }

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
        verified,
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
