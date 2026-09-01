import { Router, Response } from 'express';
import { authenticateToken, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { ApiResponse } from '../types';
import { listCloudflareZones } from '../services/cloudflareService';
import { prisma } from '../lib/prisma';
import { getCloudflareConfigFromDb, setIntegrationConfigValue } from '../services/integrationConfigService';

const router = Router();

router.get('/config', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const config = await getCloudflareConfigFromDb();
    console.log('Cloudflare config:', config);
    return res.json({
      success: true,
      data: {
        apiBase: config?.apiBase || 'https://api.cloudflare.com/client/v4',
        apiTokenSet: !!config?.apiToken,
      },
      message: 'Cloudflare config retrieved successfully',
    } as ApiResponse);
  } catch (error: any) {
    console.error('Error fetching Cloudflare config:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch Cloudflare config',
    } as ApiResponse);
  }
});

router.put('/config', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { apiBase, apiToken } = req.body as {
      apiBase?: string;
      apiToken?: string;
    };

    if (apiBase && typeof apiBase === 'string') {
      await setIntegrationConfigValue('cloudflare', 'apiBase', apiBase);
    }
    if (apiToken && typeof apiToken === 'string') {
      await setIntegrationConfigValue('cloudflare', 'apiToken', apiToken);
    }

    const config = await getCloudflareConfigFromDb();

    return res.json({
      success: true,
      data: {
        apiBase: config?.apiBase || 'https://api.cloudflare.com/client/v4',
        apiTokenSet: !!config?.apiToken,
      },
      message: 'Cloudflare config updated successfully',
    } as ApiResponse);
  } catch (error: any) {
    console.error('Error updating Cloudflare config:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to update Cloudflare config',
    } as ApiResponse);
  }
});

router.get('/zones', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const page = req.query.page ? parseInt(String(req.query.page), 10) : undefined;
    const perPage = req.query.perPage ? parseInt(String(req.query.perPage), 10) : undefined;

    const zones = await listCloudflareZones({
      page: Number.isFinite(page as number) ? (page as number) : undefined,
      perPage: Number.isFinite(perPage as number) ? (perPage as number) : undefined,
    } as { page?: number; perPage?: number });

    if (!zones) {
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch Cloudflare zones',
      } as ApiResponse);
    }

    return res.json({
      success: true,
      data: zones,
      message: 'Cloudflare zones retrieved successfully',
    } as ApiResponse);
  } catch (error: any) {
    console.error('Error fetching Cloudflare zones:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch Cloudflare zones',
    } as ApiResponse);
  }
});

// Import every Cloudflare zone as a domain. Organization stays empty — assigned later.
router.post('/sync-domains', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const perPage = 50;
    const zones: any[] = [];

    // ponytail: sequential paging, fine for a few hundred zones
    for (let page = 1; page <= 50; page++) {
      const batch = await listCloudflareZones({ page, perPage });
      if (batch === null) {
        return res.status(500).json({
          success: false,
          error: 'Failed to fetch Cloudflare zones. Check the Cloudflare integration config.',
        } as ApiResponse);
      }
      zones.push(...batch);
      if (batch.length < perPage) break;
    }

    let created = 0;
    let updated = 0;

    for (const zone of zones) {
      const name = String(zone?.name || '').trim().toLowerCase();
      if (!name) continue;

      const cloudflare = {
        zoneId: String(zone.id),
        zoneName: name,
        nameservers: Array.isArray(zone.name_servers) ? zone.name_servers : [],
        synced: true,
      };

      const existing = await prisma.domain.findUnique({ where: { name } });

      if (existing) {
        await prisma.domain.update({
          where: { id: existing.id },
          data: {
            customConfig: { ...((existing.customConfig as any) || {}), cloudflare },
          },
        });
        updated++;
      } else {
        await prisma.domain.create({
          data: {
            name,
            status: zone.status === 'active' ? 'ACTIVE' : 'PENDING',
            customConfig: { cloudflare },
            organizationId: null,
            userId: req.user!.userId,
          },
        });
        created++;
      }
    }

    return res.json({
      success: true,
      data: { total: zones.length, created, updated },
      message: `Synced ${zones.length} Cloudflare zones (${created} created, ${updated} updated)`,
    } as ApiResponse);
  } catch (error) {
    console.error('Error syncing Cloudflare domains:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

export default router;
