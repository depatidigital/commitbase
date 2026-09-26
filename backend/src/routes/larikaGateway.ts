import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { ApiResponse } from '../types';
import { canEncrypt, encrypt } from '../lib/secretBox';
import { getLarikaGatewayBaseUrl, getLarikaGatewayConfig, setLarikaGatewayValue } from '../services/integrationConfigService';
import { gateway, gatewayFailure, gatewayStats } from '../services/larikaGatewayService';

// Mounted superadmin-only in index.ts: the gateway's credentials and its WA nodes
// (the PCs running WhatsApp). Workspaces reach their numbers via /api/wa-numbers.
const router: Router = Router();

/** What the panel shows: never the key itself. */
async function status() {
  const config = await getLarikaGatewayConfig().catch(() => null);
  return { baseUrl: await getLarikaGatewayBaseUrl(), adminKeySet: !!config, adminPathSet: !!config?.adminPath };
}

router.get('/config', async (_req, res: Response) => {
  try {
    return res.json({ success: true, data: await status() } as ApiResponse);
  } catch (error) {
    console.error('Error fetching Larika Gateway config:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch Larika Gateway config' } as ApiResponse);
  }
});

router.put('/config', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { baseUrl, adminKey, adminPath } = req.body as { baseUrl?: string; adminKey?: string; adminPath?: string };
    if (baseUrl !== undefined) {
      const url = baseUrl.trim().replace(/\/+$/, '');
      if (url && !/^https?:\/\/[^\s/]+/.test(url)) {
        return res.status(400).json({ success: false, error: 'The gateway URL looks like https://gateway.larika.id' } as ApiResponse);
      }
      await setLarikaGatewayValue('baseUrl', url);
    }
    // blank keeps the stored secret
    if (adminKey?.trim() || adminPath?.trim()) {
      if (!canEncrypt()) {
        return res.status(500).json({ success: false, error: 'CB_SECRET_KEY is not set, so the key cannot be stored encrypted' } as ApiResponse);
      }
      if (adminKey?.trim()) await setLarikaGatewayValue('adminKey', encrypt(adminKey.trim()));
      if (adminPath?.trim()) await setLarikaGatewayValue('adminPath', encrypt(adminPath.trim()));
    }
    // a call proves the key, the path and the IP allowlist together
    const check = await gatewayStats()
      .then(() => null)
      .catch((error) => error?.message || 'Gateway request failed');
    return res.json({ success: true, data: { ...(await status()), check } } as ApiResponse);
  } catch (error) {
    console.error('Error updating Larika Gateway config:', error);
    return res.status(500).json({ success: false, error: 'Failed to update Larika Gateway config' } as ApiResponse);
  }
});

/** The WA nodes, with how many numbers each runs. */
router.get('/nodes', async (_req, res: Response) => {
  try {
    const stats = await gatewayStats();
    return res.json({ success: true, data: stats.agents } as ApiResponse);
  } catch (error) {
    const { status, body } = gatewayFailure(error);
    return res.status(status).json(body);
  }
});

/**
 * A connect string for a PC: a new node, or (agentId) the same node re-paired —
 * which rotates its token, so the PC that had it disconnects. `permanent`: a
 * string with no expiry (still single use) instead of a 10-minute code.
 */
router.post('/nodes/pair', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const name = String(req.body?.name ?? '').trim();
    if (!name || name.length > 80) return res.status(400).json({ success: false, error: 'Name the node (up to 80 characters)' } as ApiResponse);
    const data = await gateway('/admin/agents/pair', {
      method: 'POST',
      body: { name, permanent: !!req.body?.permanent, ...(req.body?.agentId && { agentId: String(req.body.agentId) }) },
    });
    return res.json({ success: true, data } as ApiResponse);
  } catch (error) {
    const { status, body } = gatewayFailure(error);
    return res.status(status).json(body);
  }
});

/** A permanent node's unused connect string, again. */
router.get('/nodes/:id/connect', async (req, res: Response) => {
  try {
    const data = await gateway(`/admin/agents/${encodeURIComponent(req.params.id)}/connect`);
    return res.json({ success: true, data } as ApiResponse);
  } catch (error) {
    const { status, body } = gatewayFailure(error);
    return res.status(status).json(body);
  }
});

/** Cut the PC off (token cleared); the node and its numbers stay, offline. */
router.post('/nodes/:id/revoke', async (req, res: Response) => {
  try {
    await gateway(`/admin/agents/${encodeURIComponent(req.params.id)}/revoke`, { method: 'POST' });
    return res.json({ success: true } as ApiResponse);
  } catch (error) {
    const { status, body } = gatewayFailure(error);
    return res.status(status).json(body);
  }
});

/** Delete the node; its numbers are left without one (offline) until moved. */
router.delete('/nodes/:id', async (req, res: Response) => {
  try {
    await gateway(`/admin/agents/${encodeURIComponent(req.params.id)}`, { method: 'DELETE' });
    return res.json({ success: true } as ApiResponse);
  } catch (error) {
    const { status, body } = gatewayFailure(error);
    return res.status(status).json(body);
  }
});

/** Ask online nodes (one, or all) to check for a new agent release now. */
router.post('/nodes/update', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = await gateway('/admin/agents/update', { method: 'POST', body: req.body?.agentId ? { agentId: String(req.body.agentId) } : {} });
    return res.json({ success: true, data } as ApiResponse);
  } catch (error) {
    const { status, body } = gatewayFailure(error);
    return res.status(status).json(body);
  }
});

export default router;
