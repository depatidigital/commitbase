import { Router, Response } from 'express';
import { AuthenticatedRequest, authenticateToken } from '../middleware/auth';
import { ApiResponse } from '../types';
import { prisma } from '../lib/prisma';
import { canManageOrg, isPlatformAdmin, listMemberships } from '../lib/scope';
import { GatewayError, gatewayFailure } from '../services/larikaGatewayService';
import { aiAccountOf, aiGateway, aiPricing, buyableWith, chargeFor, factorOf, sellPerMillion } from '../services/aiGatewayService';
import { billingUserOf } from '../services/walletService';
import { getLarikaAiConfig } from '../services/integrationConfigService';
import { WIB_MS } from '../services/usageMeterService';

// A workspace's AI ("AI" in the sidebar): an account on the AI gateway,
// its keys, and the rupiah wallet it is charged to. Owners and admins only — the
// keys spend the workspace's money. Money leaves as strings: micro-IDR is BigInt.
const router: Router = Router();
router.use(authenticateToken);

const fail = (res: Response, error: unknown) => {
  const { status, body } = gatewayFailure(error);
  if (status === 500) console.error('AI request failed:', error);
  return res.status(status).json(body);
};

type GatewayKey = {
  id: string;
  name: string;
  prefix: string;
  rpm: number;
  spendCap: string | null;
  capPeriod: 'DAY' | 'MONTH';
  periodSpent: string;
  period: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};
type GatewayAccount = { id: string; spent: string; spendCap: string; disabledAt: string | null; keys: GatewayKey[] };
type GatewayModel = {
  id: string;
  contextWindow: number;
  tiers: Array<{ upTo?: number; input: number; cacheRead: number; cacheWrite?: number; output: number }>;
  peak: unknown[] | null;
  enabled: boolean;
};

/**
 * A key's spending limit, per day or month: rupiah in (whole, optional), the gateway's buy-price cap
 * out — what that much rupiah buys at today's rate and markup. undefined = not
 * given, null = no limit, false = not a valid amount.
 */
async function keyCapOf(limit: unknown): Promise<bigint | null | undefined | false> {
  if (limit === undefined) return undefined;
  if (limit === null || limit === '') return null;
  const rupiah = Number(limit);
  if (!Number.isInteger(rupiah) || rupiah < 1_000 || rupiah > 1_000_000_000) return false;
  return buyableWith(BigInt(rupiah) * 1_000_000n, factorOf(await aiPricing()));
}

/** A key's limit period: per WIB day or month. */
const capPeriodOf = (value: unknown): 'DAY' | 'MONTH' | undefined => (value === 'DAY' || value === 'MONTH' ? value : undefined);

/**
 * A key as the workspace sees it: what it spent this day or month (its limit's
 * period) and the limit, in micro-IDR at today's rate.
 */
function keyView(k: GatewayKey, factor: bigint) {
  const now = new Date(Date.now() + WIB_MS).toISOString();
  const current = k.capPeriod === 'DAY' ? now.slice(0, 10) : now.slice(0, 7);
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    rpm: k.rpm,
    lastUsedAt: k.lastUsedAt,
    createdAt: k.createdAt,
    capPeriod: k.capPeriod,
    spent: String(k.period === current ? chargeFor(BigInt(k.periodSpent), factor) : 0n),
    spendCap: k.spendCap === null ? null : String(chargeFor(BigInt(k.spendCap), factor)),
  };
}

/** The workspace asked about — the active one; a platform admin may name another — when the caller manages it. */
async function orgFor(req: AuthenticatedRequest, res: Response): Promise<string | null> {
  const named = req.query.organizationId;
  const organizationId = isPlatformAdmin(req) && typeof named === 'string' && named ? named : (await listMemberships(req))[0]?.organizationId;
  if (!organizationId) {
    res.status(400).json({ success: false, error: 'Pick a workspace' } as ApiResponse);
    return null;
  }
  if (!(await canManageOrg(req, organizationId))) {
    res.status(403).json({ success: false, error: 'Only the workspace owners and admins manage its AI' } as ApiResponse);
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

/**
 * Where a workspace's AI stands: its payer (whose wallet and gateway account it uses),
 * that account, and the ids of this workspace's keys in it.
 */
async function aiOf(organizationId: string) {
  const payer = await billingUserOf(organizationId);
  const [row, mapped] = await Promise.all([
    payer ? prisma.aiAccount.findUnique({ where: { userId: payer.id } }) : null,
    prisma.aiKey.findMany({ where: { organizationId }, select: { keyId: true } }),
  ]);
  return { payer, row, keyIds: mapped.map((k) => k.keyId) };
}

/** The workspace's AI: the gateway URL, the balance that pays for it, its keys. */
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId = await orgFor(req, res);
    if (!organizationId) return;
    const config = await getLarikaAiConfig();
    const { payer, row, keyIds } = await aiOf(organizationId);
    const wallet = payer ? await prisma.wallet.findUnique({ where: { userId: payer.id } }) : null;
    let account: GatewayAccount | null = null;
    let gatewayError: string | null = null;
    if (config && row) account = await aiGateway<GatewayAccount>(`/admin/accounts/${row.accountId}`).catch((error) => ((gatewayError = error.message), null));
    const factor = factorOf(await aiPricing());
    const mine = new Set(keyIds);
    return res.json({
      success: true,
      data: {
        configured: !!config,
        baseUrl: config ? `${config.baseUrl}/v1` : null,
        organizationId,
        balance: String(wallet?.balance ?? 0n),
        payer: payer ? { name: payer.name, email: payer.email } : null,
        hasAccount: !!row,
        suspended: !!account?.disabledAt,
        // the payer's account holds every workspace's keys: only this one's are shown
        keys: account?.keys.filter((k) => !k.revokedAt && mine.has(k.id)).map((k) => keyView(k, factor)) ?? [],
        gatewayError,
      },
    } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

/** Turn AI on: the payer's gateway account (one for every workspace they pay for), capped at what their balance buys. */
router.post('/account', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId = await orgFor(req, res);
    if (!organizationId) return;
    const payer = await billingUserOf(organizationId);
    if (!payer) return res.status(409).json({ success: false, error: 'This workspace has no owner to pay for it' } as ApiResponse);
    await aiAccountOf(payer.id);
    return res.json({ success: true } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

/** A new key — its plaintext is in this answer only. In the payer's account, recorded as this workspace's. */
router.post('/keys', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId = await orgFor(req, res);
    if (!organizationId) return;
    const { row } = await aiOf(organizationId);
    if (!row) return res.status(409).json({ success: false, error: 'Turn AI on first' } as ApiResponse);
    const name = String(req.body?.name ?? '').trim();
    if (!name || name.length > 80) return res.status(400).json({ success: false, error: 'Name the key (up to 80 characters)' } as ApiResponse);
    const rpm = req.body?.rpm === undefined ? undefined : Number(req.body.rpm);
    // ponytail: 600/min ceiling for workspaces; the gateway dashboard can go higher for one key
    if (rpm !== undefined && !(Number.isInteger(rpm) && rpm >= 1 && rpm <= 600)) {
      return res.status(400).json({ success: false, error: 'Requests per minute: 1 to 600' } as ApiResponse);
    }
    const spendCap = await keyCapOf(req.body?.limit);
    if (spendCap === false) return res.status(400).json({ success: false, error: 'The limit is whole rupiah, from Rp 1,000 — or none' } as ApiResponse);
    const capPeriod = capPeriodOf(req.body?.period);
    const key = await aiGateway<{ id: string }>(`/admin/accounts/${row.accountId}/keys`, {
      method: 'POST',
      body: { name, ...(rpm && { rpm }), ...(spendCap && { spendCap: spendCap.toString() }), ...(capPeriod && { capPeriod }) },
    });
    await prisma.aiKey.create({ data: { keyId: key.id, organizationId } });
    return res.json({ success: true, data: key } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

/** This workspace's key, or a 404 answered — the gateway trusts the admin key, so whose key it is is checked here. */
async function ownKey(req: AuthenticatedRequest, res: Response) {
  const organizationId = await orgFor(req, res);
  if (!organizationId) return null;
  const keyId = String(req.params.keyId);
  if (!(await prisma.aiKey.findFirst({ where: { keyId, organizationId } }))) {
    res.status(404).json({ success: false, error: 'Key not found' } as ApiResponse);
    return null;
  }
  return keyId;
}

/** Set or lift a key's spending limit, per day or month (WIB) — so one key (a leaked one, a runaway loop) cannot drain the balance. */
router.patch('/keys/:keyId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const keyId = await ownKey(req, res);
    if (!keyId) return;
    const spendCap = await keyCapOf(req.body?.limit ?? null);
    if (spendCap === false) return res.status(400).json({ success: false, error: 'The limit is whole rupiah, from Rp 1,000 — or none' } as ApiResponse);
    const capPeriod = capPeriodOf(req.body?.period);
    await aiGateway(`/admin/keys/${keyId}`, { method: 'PATCH', body: { spendCap: spendCap === null ? null : spendCap!.toString(), ...(capPeriod && { capPeriod }) } });
    return res.json({ success: true } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

/** Revoke — the key stays recorded as this workspace's, so its last calls still bill here. */
router.delete('/keys/:keyId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const keyId = await ownKey(req, res);
    if (!keyId) return;
    await aiGateway(`/admin/keys/${keyId}`, { method: 'DELETE' });
    return res.json({ success: true } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

// the gateway's Client API catalog (its /docs/catalog.json, public): the API tab renders it
let catalog: { at: number; data: unknown } | null = null;
router.get('/api-catalog', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const config = await getLarikaAiConfig();
    if (!config) throw new GatewayError('The AI gateway integration is not set up', 503);
    if (!catalog || Date.now() - catalog.at > 10 * 60_000) {
      const response = await fetch(`${config.baseUrl}/docs/catalog.json`, { signal: AbortSignal.timeout(10_000) }).catch((error) => {
        throw new GatewayError(`Gateway unreachable: ${error.message}`, 502);
      });
      if (!response.ok) throw new GatewayError(`Gateway answered ${response.status}`, 502);
      catalog = { at: Date.now(), data: await response.json() };
    }
    return res.json({ success: true, data: catalog.data } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

/** What the playground may call: the Client API's JSON endpoints (image edits are multipart — code only). */
const PLAYGROUND_PATHS = /^\/v1\/(models|chat\/completions|images\/generations|embeddings)$/;

/**
 * The API tab's playground: one Client API call with the caller's own key, sent from
 * here because the gateway has no CORS. The answer is passed back as it came — a
 * stream as its text — and billed to the key like any other call.
 */
router.post('/playground', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId = await orgFor(req, res);
    if (!organizationId) return;
    const config = await getLarikaAiConfig();
    if (!config) throw new GatewayError('The AI gateway integration is not set up', 503);
    const { method, path, body, key } = req.body as { method?: string; path?: string; body?: unknown; key?: string };
    if (method !== 'GET' && method !== 'POST') return res.status(400).json({ success: false, error: 'GET or POST' } as ApiResponse);
    if (!path || !PLAYGROUND_PATHS.test(path)) return res.status(400).json({ success: false, error: 'The playground does not call that path' } as ApiResponse);
    if (!key?.trim()) return res.status(400).json({ success: false, error: 'Paste an API key' } as ApiResponse);
    let response: globalThis.Response;
    try {
      response = await fetch(`${config.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${key.trim()}`, ...(method === 'POST' && { 'content-type': 'application/json' }) },
        ...(method === 'POST' && { body: JSON.stringify(body ?? {}) }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (error) {
      throw new GatewayError(`Gateway unreachable: ${(error as Error).message}`, 502);
    }
    const text = await response.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* a stream, or plain text */
    }
    return res.json({ success: true, data: { ok: response.ok, status: response.status, model: response.headers.get('x-larika-model'), response: data } } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

export default router;
