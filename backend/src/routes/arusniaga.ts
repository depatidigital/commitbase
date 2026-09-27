import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { ApiResponse } from '../types';
import { prisma } from '../lib/prisma';
import { canEncrypt, encrypt } from '../lib/secretBox';
import { ARUSNIAGA_DEFAULT_URL, getArusniagaValue, setArusniagaValue } from '../services/integrationConfigService';
import { arusniagaBusiness, checkTopUps, topUpView } from '../services/arusniagaService';

// Mounted superadmin-only in index.ts: ArusNiaga (erp.depatidigital.com), where Larika's
// invoices are issued — its API key, and every workspace's top-ups.
const router: Router = Router();

async function status() {
  const [baseUrl, apiKey] = await Promise.all([getArusniagaValue('baseUrl'), getArusniagaValue('apiKey')]);
  return { baseUrl: (baseUrl || ARUSNIAGA_DEFAULT_URL).replace(/\/+$/, ''), apiKeySet: !!apiKey };
}

/** The business the key issues invoices for, or why the call failed. */
async function check() {
  return arusniagaBusiness()
    .then((business) => ({ business: business.name, error: null }))
    .catch((error) => ({ business: null, error: error?.message || 'ArusNiaga request failed' }));
}

router.get('/config', async (_req, res: Response) => {
  try {
    const s = await status();
    return res.json({ success: true, data: { ...s, ...(s.apiKeySet ? await check() : { business: null, error: null }) } } as ApiResponse);
  } catch (error) {
    console.error('Error fetching ArusNiaga config:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch the ArusNiaga config' } as ApiResponse);
  }
});

router.put('/config', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { baseUrl, apiKey } = req.body as { baseUrl?: string; apiKey?: string };
    if (baseUrl !== undefined) {
      const url = baseUrl.trim().replace(/\/+$/, '');
      if (url && !/^https?:\/\/[^\s/]+/.test(url)) return res.status(400).json({ success: false, error: 'The URL looks like https://erp.depatidigital.com' } as ApiResponse);
      await setArusniagaValue('baseUrl', url);
    }
    // blank keeps the stored key
    if (apiKey?.trim()) {
      if (!canEncrypt()) return res.status(500).json({ success: false, error: 'CB_SECRET_KEY is not set, so the key cannot be stored encrypted' } as ApiResponse);
      await setArusniagaValue('apiKey', encrypt(apiKey.trim()));
    }
    return res.json({ success: true, data: { ...(await status()), ...(await check()) } } as ApiResponse);
  } catch (error) {
    console.error('Error updating ArusNiaga config:', error);
    return res.status(500).json({ success: false, error: 'Failed to update the ArusNiaga config' } as ApiResponse);
  }
});

/** Every workspace's top-ups, newest first. ?status= to narrow. */
router.get('/topups', async (req, res: Response) => {
  try {
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    const rows = await prisma.topUp.findMany({
      where: { invoiceId: { not: null }, ...(status && { status }) },
      include: { organization: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return res.json({ success: true, data: rows.map((t) => ({ ...topUpView(t), organizationName: t.organization.name })) } as ApiResponse);
  } catch (error) {
    console.error('Error listing top-ups:', error);
    return res.status(500).json({ success: false, error: 'Failed to list top-ups' } as ApiResponse);
  }
});

/** Ask ArusNiaga about the pending top-ups now, not at the next minute. */
router.post('/topups/check', async (_req, res: Response) => {
  try {
    return res.json({ success: true, data: { summary: await checkTopUps() } } as ApiResponse);
  } catch (error: any) {
    return res.status(502).json({ success: false, error: error?.message || 'Check failed' } as ApiResponse);
  }
});

export default router;
