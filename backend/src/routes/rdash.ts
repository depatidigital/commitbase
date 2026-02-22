import { Router, Request, Response } from 'express';
import { getRdashAccountProfile, registerRdashDomain, updateRdashDomainNameservers, listRdashDomains } from '../services/rdashService';
import { setIntegrationConfigValue, getRdashConfigFromDb } from '../services/integrationConfigService';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { ApiResponse } from '../types';

const router = Router();

router.get('/profile', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const profile = await getRdashAccountProfile();

    if (!profile) {
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch RDASH account profile',
      } as ApiResponse);
    }

    return res.json({
      success: true,
      data: profile,
      message: 'RDASH account profile retrieved successfully',
    } as ApiResponse);
  } catch (error: any) {
    console.error('Error fetching RDASH profile:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

router.get('/domains', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await listRdashDomains(req.query as Record<string, any>);

    return res.json({
      success: true,
      data: result,
      message: 'RDASH domains retrieved successfully',
    } as ApiResponse);
  } catch (error: any) {
    console.error('Error fetching RDASH domains:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch RDASH domains',
    } as ApiResponse);
  }
});

router.get('/summary', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const [profile, domains] = await Promise.all([
      getRdashAccountProfile(),
      listRdashDomains(req.query as Record<string, any>),
    ]);

    const balance =
      profile &&
      (profile.balance ??
        profile.credit ??
        profile.available_balance ??
        profile.availableBalance ??
        null);

    return res.json({
      success: true,
      data: {
        profile,
        domains,
        balance,
      },
      message: 'RDASH summary retrieved successfully',
    } as ApiResponse);
  } catch (error: any) {
    console.error('Error fetching RDASH summary:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch RDASH summary',
    } as ApiResponse);
  }
});

router.get('/config', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const config = await getRdashConfigFromDb();

    return res.json({
      success: true,
      data: {
        baseUrl: config?.baseUrl || 'https://api.rdash.id/v1',
        resellerIdSet: !!config?.resellerId,
        apiKeySet: !!config?.apiKey,
      },
      message: 'RDASH config retrieved successfully',
    } as ApiResponse);
  } catch (error: any) {
    console.error('Error fetching RDASH config:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch RDASH config',
    } as ApiResponse);
  }
});

router.put('/config', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { baseUrl, resellerId, apiKey } = req.body as {
      baseUrl?: string;
      resellerId?: string;
      apiKey?: string;
    };

    if (baseUrl && typeof baseUrl === 'string') {
      await setIntegrationConfigValue('rdash', 'baseUrl', baseUrl);
    }
    if (resellerId && typeof resellerId === 'string') {
      await setIntegrationConfigValue('rdash', 'resellerId', resellerId);
    }
    if (apiKey && typeof apiKey === 'string') {
      await setIntegrationConfigValue('rdash', 'apiKey', apiKey);
    }

    const config = await getRdashConfigFromDb();

    return res.json({
      success: true,
      data: {
        baseUrl: config?.baseUrl || 'https://api.rdash.id/v1',
        resellerIdSet: !!config?.resellerId,
        apiKeySet: !!config?.apiKey,
      },
      message: 'RDASH config updated successfully',
    } as ApiResponse);
  } catch (error: any) {
    console.error('Error updating RDASH config:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to update RDASH config',
    } as ApiResponse);
  }
});

router.post('/domains/register', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await registerRdashDomain(req.body);

    return res.status(201).json({
      success: true,
      data: result,
      message: 'RDASH domain registered successfully',
    } as ApiResponse);
  } catch (error: any) {
    console.error('Error registering RDASH domain:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to register domain via RDASH',
    } as ApiResponse);
  }
});

router.post('/domains/:domain/nameservers/cloudflare', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const domain = req.params.domain as string;
    const result = await updateRdashDomainNameservers(domain, req.body);

    return res.json({
      success: true,
      data: result,
      message: 'RDASH domain nameservers updated to Cloudflare',
    } as ApiResponse);
  } catch (error: any) {
    console.error('Error updating RDASH domain nameservers:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to update domain nameservers via RDASH',
    } as ApiResponse);
  }
});

export default router;
