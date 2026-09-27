import { Router, Response } from 'express';
import { AuthenticatedRequest, authenticateToken } from '../middleware/auth';
import { ApiResponse } from '../types';
import { prisma } from '../lib/prisma';
import { canManageOrg, isPlatformAdmin, listMemberships } from '../lib/scope';
import { gatewayFailure } from '../services/larikaGatewayService';
import { aiGateway, aiPricing, sellPerMillion, syncAiCap } from '../services/aiGatewayService';
import { getLarikaAiConfig } from '../services/integrationConfigService';

// A workspace's AI API ("AI API" in the sidebar): an account on the AI gateway,
// its keys, and the rupiah wallet it is charged to. Owners and admins only — the
// keys spend the workspace's money. Money leaves as strings: micro-IDR is BigInt.
const router: Router = Router();
router.use(authenticateToken);

const fail = (res: Response, error: unknown) => {
  const { status, body } = gatewayFailure(error);
  if (status === 500) console.error('AI API request failed:', error);
  return res.status(status).json(body);
};

type GatewayKey = { id: string; name: string; prefix: string; rpm: number; revokedAt: string | null; lastUsedAt: string | null; createdAt: string };
type GatewayAccount = { id: string; spent: string; spendCap: string; disabledAt: string | null; keys: GatewayKey[] };
type GatewayModel = {
  id: string;
  contextWindow: number;
  tiers: Array<{ upTo?: number; input: number; cacheRead: number; cacheWrite?: number; output: number }>;
  peak: unknown[] | null;
  enabled: boolean;
};

/** The workspace asked about — the active one; a platform admin may name another — when the caller manages it. */
async function orgFor(req: AuthenticatedRequest, res: Response): Promise<string | null> {
  const named = req.query.organizationId;
  const organizationId = isPlatformAdmin(req) && typeof named === 'string' && named ? named : (await listMemberships(req))[0]?.organizationId;
  if (!organizationId) {
    res.status(400).json({ success: false, error: 'Pick a workspace' } as ApiResponse);
    return null;
  }
  if (!(await canManageOrg(req, organizationId))) {
    res.status(403).json({ success: false, error: 'Only the workspace owners and admins manage its AI API' } as ApiResponse);
    return null;
  }
  return organizationId;
}

/** The models on sale, at our price: rupiah per 1M tokens. Every signed-in user (the Pricing page). */
router.get('/models', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    if (!(await getLarikaAiConfig())) return res.json({ success: true, data: [] } as ApiResponse);
    const [models, pricing] = await Promise.all([aiGateway<GatewayModel[]>('/admin/models'), aiPricing()]);
    const idr = (usd: number | undefined) => (usd === undefined ? null : sellPerMillion(usd, pricing));
    const data = models
      .filter((m) => m.enabled)
      .map((m) => ({
        id: m.id,
        contextWindow: m.contextWindow,
        // peak-hour models are listed at their base (off-peak) price; peak multiplies it
        peak: !!m.peak?.length,
        tiers: m.tiers.map((t) => ({ upTo: t.upTo ?? null, input: idr(t.input), cacheRead: idr(t.cacheRead), cacheWrite: idr(t.cacheWrite ?? t.input), output: idr(t.output) })),
      }));
    return res.json({ success: true, data } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

/** The workspace's AI API: the gateway URL, its balance, its account and keys. */
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId = await orgFor(req, res);
    if (!organizationId) return;
    const config = await getLarikaAiConfig();
    const [row, wallet] = await Promise.all([
      prisma.aiAccount.findUnique({ where: { organizationId } }),
      prisma.wallet.findUnique({ where: { organizationId } }),
    ]);
    let account: GatewayAccount | null = null;
    let gatewayError: string | null = null;
    if (config && row) account = await aiGateway<GatewayAccount>(`/admin/accounts/${row.accountId}`).catch((error) => ((gatewayError = error.message), null));
    return res.json({
      success: true,
      data: {
        configured: !!config,
        baseUrl: config ? `${config.baseUrl}/v1` : null,
        organizationId,
        balance: String(wallet?.balance ?? 0n),
        hasAccount: !!row,
        suspended: !!account?.disabledAt,
        keys: account?.keys.filter((k) => !k.revokedAt) ?? [],
        gatewayError,
      },
    } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

/** Turn the AI API on: an account on the gateway, capped at what the balance buys. */
router.post('/account', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId = await orgFor(req, res);
    if (!organizationId) return;
    if (!(await prisma.aiAccount.findUnique({ where: { organizationId } }))) {
      const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true, slug: true } });
      const account = await aiGateway<{ id: string }>('/admin/accounts', { method: 'POST', body: { name: `${org.name} (${org.slug})` } });
      await prisma.aiAccount.create({ data: { organizationId, accountId: account.id } });
    }
    await syncAiCap(organizationId);
    return res.json({ success: true } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

async function accountOf(organizationId: string) {
  return prisma.aiAccount.findUnique({ where: { organizationId } });
}

/** A new key — its plaintext is in this answer only. */
router.post('/keys', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId = await orgFor(req, res);
    if (!organizationId) return;
    const row = await accountOf(organizationId);
    if (!row) return res.status(409).json({ success: false, error: 'Turn the AI API on first' } as ApiResponse);
    const name = String(req.body?.name ?? '').trim();
    if (!name || name.length > 80) return res.status(400).json({ success: false, error: 'Name the key (up to 80 characters)' } as ApiResponse);
    const rpm = req.body?.rpm === undefined ? undefined : Number(req.body.rpm);
    // ponytail: 600/min ceiling for workspaces; the gateway dashboard can go higher for one key
    if (rpm !== undefined && !(Number.isInteger(rpm) && rpm >= 1 && rpm <= 600)) {
      return res.status(400).json({ success: false, error: 'Requests per minute: 1 to 600' } as ApiResponse);
    }
    const key = await aiGateway(`/admin/accounts/${row.accountId}/keys`, { method: 'POST', body: { name, ...(rpm && { rpm }) } });
    return res.json({ success: true, data: key } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

router.delete('/keys/:keyId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId = await orgFor(req, res);
    if (!organizationId) return;
    const row = await accountOf(organizationId);
    // the gateway trusts the admin key: that the key is this workspace's is checked here
    const account = row && (await aiGateway<GatewayAccount>(`/admin/accounts/${row.accountId}`));
    if (!account?.keys.some((k) => k.id === req.params.keyId)) return res.status(404).json({ success: false, error: 'Key not found' } as ApiResponse);
    await aiGateway(`/admin/keys/${req.params.keyId}`, { method: 'DELETE' });
    return res.json({ success: true } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

export default router;
