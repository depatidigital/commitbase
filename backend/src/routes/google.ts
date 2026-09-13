import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { ApiResponse } from '../types';
import { canEncrypt, encrypt } from '../lib/secretBox';
import { getGoogleConfigFromDb, setGoogleConfigValue, splitEmails } from '../services/integrationConfigService';
import { checkGoogleAccess } from '../services/searchConsoleService';

// Mounted superadmin-only in index.ts, like the other integration credentials.
const router = Router();

/** What the panel shows: never the key itself. */
async function googleStatus() {
  const config = await getGoogleConfigFromDb().catch(() => null);
  return { clientEmail: config?.clientEmail ?? '', owners: config?.owners.join(', ') ?? '' };
}

router.get('/search-console', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json({ success: true, data: await googleStatus() } as ApiResponse);
  } catch (error) {
    console.error('Error fetching Google config:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch Google config' } as ApiResponse);
  }
});

router.put('/search-console', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { serviceAccount, owners } = req.body as { serviceAccount?: string; owners?: string };

    // blank keeps the stored key
    if (serviceAccount?.trim()) {
      let key: any;
      try {
        key = JSON.parse(serviceAccount);
      } catch {
        return res.status(400).json({ success: false, error: 'The service account key is not valid JSON' } as ApiResponse);
      }
      if (!key?.client_email || !key?.private_key) {
        return res.status(400).json({ success: false, error: 'Paste the whole service account key file (it has client_email and private_key)' } as ApiResponse);
      }
      if (!canEncrypt()) {
        return res.status(500).json({ success: false, error: 'CB_SECRET_KEY is not set, so the key cannot be stored encrypted' } as ApiResponse);
      }
      await setGoogleConfigValue('serviceAccount', encrypt(JSON.stringify({ client_email: key.client_email, private_key: key.private_key })));
    }
    if (owners !== undefined) {
      await setGoogleConfigValue('owners', splitEmails(owners).join(','));
    }

    return res.json({ success: true, data: { ...(await googleStatus()), check: await checkGoogleAccess() } } as ApiResponse);
  } catch (error) {
    console.error('Error updating Google config:', error);
    return res.status(500).json({ success: false, error: 'Failed to update Google config' } as ApiResponse);
  }
});

export default router;
