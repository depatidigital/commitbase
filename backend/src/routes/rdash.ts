import { Router, Request, Response } from 'express';
import { getRdashAccountProfile, registerRdashDomain, updateRdashDomainNameservers, listRdashDomains, getRdashBalance } from '../services/rdashService';
import { setIntegrationConfigValue, getRdashConfigFromDb } from '../services/integrationConfigService';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { ApiResponse } from '../types';

const router = Router();

// RDASH errors arrive as a JSON body string - pull out .message when present
function upstreamMessage(error: any): string {
  const raw = error?.message ? String(error.message) : String(error);
  try {
    const parsed = JSON.parse(raw);
    return parsed?.message || parsed?.error || raw;
  } catch {
    return raw;
  }
}

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
    const [profile, domains, balance] = await Promise.allSettled([
      getRdashAccountProfile(),
      listRdashDomains(req.query as Record<string, any>),
      getRdashBalance(),
    ]);

    // ponytail: partial summary beats a 500 - surface upstream message per section
    const errors: Record<string, string> = {};
    const unwrap = <T,>(key: string, r: PromiseSettledResult<T>): T | null => {
      if (r.status === 'fulfilled') return r.value;
      errors[key] = upstreamMessage(r.reason);
      return null;
    };

    return res.json({
      success: true,
      data: {
        profile: unwrap('profile', profile),
        domains: unwrap('domains', domains),
        balance: unwrap('balance', balance),
        errors: Object.keys(errors).length ? errors : undefined,
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
