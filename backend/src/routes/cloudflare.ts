import { Router, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { ApiResponse } from '../types';
import { listCloudflareZones } from '../services/cloudflareService';
import { getCloudflareConfigFromDb, setIntegrationConfigValue } from '../services/integrationConfigService';

const router = Router();

router.get('/config', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const config = await getCloudflareConfigFromDb();

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

export default router;
