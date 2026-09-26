import { Router, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { AuthenticatedRequest } from '../middleware/auth';
import { ApiResponse } from '../types';
import { prisma } from '../lib/prisma';
import { canEncrypt, encrypt } from '../lib/secretBox';
import { getLarikaAiValue, LARIKA_AI_DEFAULT_URL, setLarikaAiValue } from '../services/integrationConfigService';
import { gatewayFailure } from '../services/larikaGatewayService';
import { addWalletEntry, aiGateway, aiPricing, syncAllAiCaps } from '../services/aiGatewayService';

// Mounted superadmin-only in index.ts: the AI gateway's credentials, how its buy
// prices are sold (rate × markup), and wallets credited by hand until top-ups by
// payment exist. Providers, models and buy prices are set on the gateway's own dashboard.
const router: Router = Router();

async function status() {
  const [baseUrl, adminKey, adminPath, pricing] = await Promise.all([getLarikaAiValue('baseUrl'), getLarikaAiValue('adminKey'), getLarikaAiValue('adminPath'), aiPricing()]);
  return { baseUrl: (baseUrl || LARIKA_AI_DEFAULT_URL).replace(/\/+$/, ''), adminKeySet: !!adminKey, adminPathSet: !!adminPath, ...pricing };
}

router.get('/config', async (_req, res: Response) => {
  try {
    return res.json({ success: true, data: await status() } as ApiResponse);
  } catch (error) {
    console.error('Error fetching AI gateway config:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch the AI gateway config' } as ApiResponse);
  }
});

router.put('/config', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { baseUrl, adminKey, adminPath, rate, markup } = req.body as { baseUrl?: string; adminKey?: string; adminPath?: string; rate?: number; markup?: number };
    if (baseUrl !== undefined) {
      const url = baseUrl.trim().replace(/\/+$/, '');
      if (url && !/^https?:\/\/[^\s/]+/.test(url)) return res.status(400).json({ success: false, error: 'The gateway URL looks like https://ai.larika.id' } as ApiResponse);
      await setLarikaAiValue('baseUrl', url);
    }
    if (rate !== undefined && !(Number(rate) >= 1_000 && Number(rate) <= 100_000)) {
      return res.status(400).json({ success: false, error: 'The rate is rupiah per US dollar, e.g. 18200' } as ApiResponse);
    }
    if (markup !== undefined && !(Number(markup) >= 1 && Number(markup) <= 10)) {
      return res.status(400).json({ success: false, error: 'The markup is a factor from 1 (no margin) up, e.g. 1.044' } as ApiResponse);
    }
    const before = await aiPricing();
    if (rate !== undefined) await setLarikaAiValue('rate', String(Number(rate)));
    if (markup !== undefined) await setLarikaAiValue('markup', String(Number(markup)));
    // blank keeps the stored secret
    if (adminKey?.trim() || adminPath?.trim()) {
      if (!canEncrypt()) return res.status(500).json({ success: false, error: 'CB_SECRET_KEY is not set, so the key cannot be stored encrypted' } as ApiResponse);
      if (adminKey?.trim()) await setLarikaAiValue('adminKey', encrypt(adminKey.trim()));
      if (adminPath?.trim()) await setLarikaAiValue('adminPath', encrypt(adminPath.trim()));
    }
    // a call proves the key, the path and the IP allowlist together
    const check = await aiGateway('/admin/stats')
      .then(() => null)
      .catch((error) => error?.message || 'Gateway request failed');
    // a new price moves what every balance buys
    const after = await aiPricing();
    if (!check && (after.rate !== before.rate || after.markup !== before.markup)) await syncAllAiCaps();
    return res.json({ success: true, data: { ...(await status()), check } } as ApiResponse);
  } catch (error) {
    console.error('Error updating AI gateway config:', error);
    return res.status(500).json({ success: false, error: 'Failed to update the AI gateway config' } as ApiResponse);
  }
});

/** Every wallet, with its workspace and whether it has an AI account. */
router.get('/wallets', async (_req, res: Response) => {
  try {
    const orgs = await prisma.organization.findMany({
      where: { OR: [{ wallet: { isNot: null } }, { aiAccount: { isNot: null } }] },
      select: { id: true, name: true, wallet: { select: { balance: true, updatedAt: true } }, aiAccount: { select: { accountId: true } } },
      orderBy: { name: 'asc' },
    });
    const data = orgs.map((o) => ({ organizationId: o.id, name: o.name, balance: String(o.wallet?.balance ?? 0n), updatedAt: o.wallet?.updatedAt ?? null, aiAccountId: o.aiAccount?.accountId ?? null }));
    return res.json({ success: true, data } as ApiResponse);
  } catch (error) {
    console.error('Error listing wallets:', error);
    return res.status(500).json({ success: false, error: 'Failed to list wallets' } as ApiResponse);
  }
});

/**
 * Credit (or, negative, debit) a workspace by hand — the beta's top-up, and
 * corrections. Rupiah in; an ADJUST entry with who and why; the cap follows.
 */
router.post('/credit', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId = String(req.body?.organizationId ?? '');
    const amount = Number(req.body?.amount);
    const note = String(req.body?.note ?? '').trim();
    if (!(await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true } }))) {
      return res.status(400).json({ success: false, error: 'Pick a workspace' } as ApiResponse);
    }
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1_000_000_000) {
      return res.status(400).json({ success: false, error: 'The amount is rupiah, not zero (negative takes money back)' } as ApiResponse);
    }
    if (!note) return res.status(400).json({ success: false, error: 'Say why: it is on the workspace statement' } as ApiResponse);
    await addWalletEntry({
      organizationId,
      kind: 'ADJUST',
      amount: BigInt(Math.round(amount)) * 1_000_000n,
      ref: `adjust:${randomUUID()}`,
      note,
      createdById: req.user!.userId,
    });
    return res.json({ success: true } as ApiResponse);
  } catch (error) {
    console.error('Error crediting a wallet:', error);
    return res.status(500).json({ success: false, error: 'Failed to credit the wallet' } as ApiResponse);
  }
});

/** Suspend a workspace's AI API (every key refused), or resume it. */
router.patch('/accounts/:organizationId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const row = await prisma.aiAccount.findUnique({ where: { organizationId: String(req.params.organizationId) } });
    if (!row) return res.status(404).json({ success: false, error: 'This workspace has no AI account' } as ApiResponse);
    await aiGateway(`/admin/accounts/${row.accountId}`, { method: 'PATCH', body: { disabled: !!req.body?.disabled } });
    return res.json({ success: true } as ApiResponse);
  } catch (error) {
    const { status, body } = gatewayFailure(error);
    return res.status(status).json(body);
  }
});

export default router;
