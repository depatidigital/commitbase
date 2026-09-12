import { Router, Response } from 'express';
import { authenticateToken, AuthenticatedRequest, requireRole } from '../middleware/auth';
import { ApiResponse } from '../types';
import { listCloudflareZones } from '../services/cloudflareService';
import { z } from 'zod';
import {
  getCloudflareConfigFromDb,
  setIntegrationConfigValue,
  getIntegrationConfigValue,
  setR2ConfigValue,
  R2_KEYS,
  type R2Key,
} from '../services/integrationConfigService';
import { checkR2Access } from '../services/r2Service';
import { canEncrypt, encrypt } from '../lib/secretBox';

const router = Router();

// The platform's Cloudflare token (DNS for every zone, and R2): superadmins
// only — the integrations pages are theirs alone. No roles = SUPERADMIN.
router.use(authenticateToken, requireRole([]));

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

/** What the panel shows of the R2 settings: everything but the secret. */
async function r2Status() {
  const [accountId, accessKeyId, secret, bucket, publicUrl, rootDir] = await Promise.all(
    R2_KEYS.map((key) => getIntegrationConfigValue('r2', key)),
  );
  return {
    accountId: accountId || '',
    accessKeyId: accessKeyId || '',
    secretAccessKeySet: !!secret,
    bucket: bucket || '',
    publicUrl: publicUrl || '',
    rootDir: rootDir || '',
  };
}

const R2ConfigSchema = z.object({
  accountId: z.string().trim().regex(/^[0-9a-f]{32}$/i, 'Account ID is 32 hex characters').optional(),
  accessKeyId: z.string().trim().min(1).optional(),
  // blank keeps the stored one
  secretAccessKey: z.string().trim().optional(),
  bucket: z.string().trim().regex(/^([a-z0-9][a-z0-9-]{1,61}[a-z0-9])?$/, 'Bucket names are lowercase letters, digits and hyphens').optional(),
  publicUrl: z.string().trim().regex(/^(https:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(\/[\w./-]*)?$/i, 'Public URL is the bucket\'s custom domain, e.g. https://cdn.example.com').or(z.literal('')).optional(),
  rootDir: z.string().trim().regex(/^([\w.-]+(\/[\w.-]+)*)?$/, 'Root folder is a plain path like larika or sites/larika').optional(),
});

router.get('/r2', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json({ success: true, data: await r2Status() } as ApiResponse);
  } catch (error) {
    console.error('Error fetching R2 config:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch R2 config' } as ApiResponse);
  }
});

router.put('/r2', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const parsed = R2ConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid R2 settings' } as ApiResponse);
    }
    const { secretAccessKey, ...plain } = parsed.data;

    if (secretAccessKey) {
      if (!canEncrypt()) {
        return res.status(500).json({ success: false, error: 'CB_SECRET_KEY is not set, so the secret cannot be stored encrypted' } as ApiResponse);
      }
      await setR2ConfigValue('secretAccessKey', encrypt(secretAccessKey));
    }
    for (const [key, value] of Object.entries(plain)) {
      if (value !== undefined) await setR2ConfigValue(key as R2Key, value);
    }

    return res.json({ success: true, data: { ...(await r2Status()), check: await checkR2Access() } } as ApiResponse);
  } catch (error) {
    console.error('Error updating R2 config:', error);
    return res.status(500).json({ success: false, error: 'Failed to update R2 config' } as ApiResponse);
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
