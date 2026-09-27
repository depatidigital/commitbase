import { prisma } from '../lib/prisma';
import { callGateway, GatewayError, type GatewayInit } from './larikaGatewayService';
import { getLarikaAiConfig, getLarikaAiValue } from './integrationConfigService';
import { WIB_MS } from './usageMeterService';

/**
 * The AI gateway (larika-ai-gateway, ai.larika.id): an OpenAI-compatible API that
 * meters each call at its **buy** price, micro-USD, and refuses calls past a spend
 * cap. Selling is ours: every call is charged `buy × rate × markup` to the
 * workspace's rupiah wallet, and the cap is set so the wallet cannot go under.
 */

export async function aiGateway<T = any>(path: string, init: GatewayInit = {}): Promise<T> {
  const config = await getLarikaAiConfig();
  if (!config) throw new GatewayError('The AI gateway integration is not set up', 503);
  return callGateway<T>(config, path, init);
}

// ── Money ──

/**
 * Until the superadmin sets them: market IDR per USD, the one markup over it, and the
 * markup on calls larika-optima routed — the model's price plus the routing service.
 */
export const DEFAULT_RATE = 18_200;
export const DEFAULT_MARKUP = 1.044;
export const DEFAULT_OPTIMA_MARKUP = 1.15;

export type AiPricing = { rate: number; markup: number; optimaMarkup: number };

export async function aiPricing(): Promise<AiPricing> {
  const [rate, markup, optimaMarkup] = await Promise.all([getLarikaAiValue('rate'), getLarikaAiValue('markup'), getLarikaAiValue('optimaMarkup')]);
  return { rate: Number(rate) || DEFAULT_RATE, markup: Number(markup) || DEFAULT_MARKUP, optimaMarkup: Number(optimaMarkup) || DEFAULT_OPTIMA_MARKUP };
}

/** rate × markup, ×10⁴ so the money math stays in BigInt. */
const SCALE = 10_000n;
export const factorOf = ({ rate, markup }: { rate: number; markup: number }) => BigInt(Math.round(rate * markup * 10_000));
/** What a call larika-optima routed is charged at. */
export const optimaFactorOf = (p: AiPricing) => factorOf({ rate: p.rate, markup: p.optimaMarkup });
/**
 * Spend caps and key limits turn rupiah into buy price at the dearer of the two markups,
 * so a balance never buys more than it pays for, whichever way the calls go.
 */
export const capFactorOf = (p: AiPricing) => factorOf({ rate: p.rate, markup: Math.max(p.markup, p.optimaMarkup) });

/** A buy cost (micro-USD) → what the workspace pays (micro-IDR), rounded up. micro-USD × IDR/USD = micro-IDR. */
export const chargeFor = (costMicroUsd: bigint, factor: bigint) => (costMicroUsd * factor + SCALE - 1n) / SCALE;

/**
 * A turn larika-optima routed, charged (micro-IDR). The model that answered plus the turn's
 * routing, at the optima markup — but never more than the same tokens on the cheapest top
 * model at the normal markup, so routing that saved nothing costs nothing extra; and never
 * less than the model that answered at the normal markup. No baseline (a tool loop carried
 * on, unrouted): the normal price.
 */
export function chargeRouted(cost: bigint, routingCost: bigint, baselineCost: bigint | null, p: AiPricing) {
  const normal = factorOf(p);
  const floor = chargeFor(cost, normal);
  if (baselineCost === null) return floor;
  const withService = chargeFor(cost + routingCost, optimaFactorOf(p));
  const ceiling = chargeFor(baselineCost, normal);
  const capped = withService < ceiling ? withService : ceiling;
  return capped > floor ? capped : floor;
}

/** What a balance (micro-IDR) buys at buy price (micro-USD), rounded down. Nothing when it is not positive. */
export const buyableWith = (balanceMicroIdr: bigint, factor: bigint) => (balanceMicroIdr > 0n ? (balanceMicroIdr * SCALE) / factor : 0n);

/** A buy price (USD per 1M tokens) as we sell it (IDR per 1M tokens). */
export const sellPerMillion = (usdPerMillion: number, p: AiPricing) => usdPerMillion * p.rate * p.markup;

// ── Spend cap ──

/**
 * Tell the gateway how far a payer's account — every workspace they pay for — may go:
 * what was billed so far plus what their balance buys. One statement reads both, so a
 * billing run in between cannot pair an old balance with a new billed total.
 */
export async function syncAiCap(userId: string) {
  const [row] = await prisma.$queryRaw<Array<{ accountId: string; billedSpent: bigint; balance: bigint }>>`
    SELECT a."accountId", a."billedSpent", coalesce(w.balance, 0)::bigint AS balance
    FROM ai_accounts a LEFT JOIN wallets w ON w."userId" = a."userId"
    WHERE a."userId" = ${userId}`;
  if (!row) return;
  const cap = row.billedSpent + buyableWith(row.balance, capFactorOf(await aiPricing()));
  await aiGateway(`/admin/accounts/${row.accountId}`, { method: 'PATCH', body: { spendCap: cap.toString() } });
}

/** The payer's gateway account — opened, capped at what their balance buys, on first use. */
export async function aiAccountOf(userId: string) {
  const had = await prisma.aiAccount.findUnique({ where: { userId } });
  if (had) return had;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  const account = await aiGateway<{ id: string }>('/admin/accounts', { method: 'POST', body: { name: user.email } });
  const row = await prisma.aiAccount.create({ data: { userId, accountId: account.id } });
  await syncAiCap(userId);
  return row;
}

/**
 * A workspace changed payer: its keys move to the new payer's account, so what they
 * spend from now on comes off the new payer's cap. What they spent before stays where it
 * was billed.
 */
export async function moveWorkspaceKeys(organizationId: string, toUserId: string) {
  const keys = await prisma.aiKey.findMany({ where: { organizationId }, select: { keyId: true } });
  if (!keys.length) return 0;
  const account = await aiAccountOf(toUserId);
  for (const { keyId } of keys) await aiGateway(`/admin/keys/${keyId}`, { method: 'PATCH', body: { accountId: account.accountId } });
  return keys.length;
}

// ── Billing ──

type FeedRequest = {
  id: string;
  accountId: string;
  keyId: string;
  model: string;
  cost: string;
  via: string | null;
  /** routed rows: the same tokens on the cheapest top model, and the turn's routing (router.ts) */
  baselineCost: string | null;
  routingCost: string | null;
  createdAt: string;
};
const PAGE = 1000;
/** Serialises billing runs across processes; the cursor is re-checked under it. */
const BILLING_LOCK = 7_431_001;

/**
 * Charge what the gateway metered since the last run: its request feed, read from
 * our cursor, priced `buy × rate × markup` (larika-optima's turns by chargeRouted), added
 * to the payer's wallet — one entry per workspace (the key's), WIB day and model. Each
 * page is one transaction that also moves the cursor, so a crash re-reads the page and
 * nothing is charged twice. Then each payer billed gets their new spend cap.
 */
export async function billAiUsage(): Promise<string> {
  if (!(await getLarikaAiConfig())) return 'skipped — the AI gateway is not set up';
  const pricing = await aiPricing();
  const factor = factorOf(pricing);
  // whose wallet (the account's payer) and which workspace (the key's)
  const owners = new Map((await prisma.aiAccount.findMany({ select: { userId: true, accountId: true } })).map((a) => [a.accountId, a.userId]));
  const workspaces = new Map((await prisma.aiKey.findMany({ select: { keyId: true, organizationId: true } })).map((k) => [k.keyId, k.organizationId]));
  let cursor = (await getLarikaAiValue('cursor')) ?? '0';
  const touched = new Set<string>();
  let billed = 0;

  for (;;) {
    const page = await aiGateway<{ requests: FeedRequest[]; next: string }>(`/admin/requests?after=${cursor}&limit=${PAGE}`);
    if (!page.requests.length) break;

    const entries = new Map<string, { userId: string; organizationId: string | null; amount: bigint; note: string }>();
    const spent = new Map<string, bigint>();
    for (const r of page.requests) {
      // an account made on the gateway's own dashboard belongs to no one here
      const userId = owners.get(r.accountId);
      const organizationId = workspaces.get(r.keyId) ?? null;
      const cost = BigInt(r.cost);
      if (!userId || cost === 0n) continue;
      spent.set(userId, (spent.get(userId) ?? 0n) + cost);
      billed++;
      // larika-optima's classifier call: bought, not charged on its own — the turn it
      // routed carries it (chargeRouted), so a turn that saved nothing pays nothing for it
      if (r.model.endsWith(':router')) continue;
      const day = new Date(new Date(r.createdAt).getTime() + WIB_MS).toISOString().slice(0, 10);
      // the models larika-optima picked: on lines of their own (`:optima`), so "you saved" can add them up
      // one line a day per workspace, model and payer — a workspace that changes payer
      // mid-day starts a line of the new payer's instead of adding to the old one's
      const ref = `ai:${organizationId ?? 'none'}:${day}:${r.model}:${userId}${r.via ? ':optima' : ''}`;
      const label = r.via ? `${r.model} via ${r.via}` : r.model;
      const entry = entries.get(ref) ?? { userId, organizationId, amount: 0n, note: `AI · ${label} · ${day}` };
      entry.amount += r.via
        ? chargeRouted(cost, BigInt(r.routingCost ?? 0), r.baselineCost === null ? null : BigInt(r.baselineCost), pricing)
        : chargeFor(cost, factor);
      entries.set(ref, entry);
    }

    const from = cursor;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BILLING_LOCK})`;
      const stored = await tx.integrationConfig.findUnique({ where: { provider_key: { provider: 'larika_ai', key: 'cursor' } } });
      if ((stored?.value ?? '0') !== from) throw new Error('AI billing: the cursor moved under this run — another run billed this page');
      for (const [ref, e] of entries) {
        await tx.walletEntry.upsert({
          where: { ref },
          create: { ref, userId: e.userId, organizationId: e.organizationId, kind: 'AI_USAGE', amount: -e.amount, note: e.note },
          update: { amount: { decrement: e.amount } },
        });
        await tx.wallet.upsert({
          where: { userId: e.userId },
          create: { userId: e.userId, balance: -e.amount },
          update: { balance: { decrement: e.amount } },
        });
      }
      for (const [userId, cost] of spent) {
        await tx.aiAccount.update({ where: { userId }, data: { billedSpent: { increment: cost } } });
      }
      await tx.integrationConfig.upsert({
        where: { provider_key: { provider: 'larika_ai', key: 'cursor' } },
        create: { provider: 'larika_ai', key: 'cursor', value: String(page.next) },
        update: { value: String(page.next) },
      });
    });
    cursor = String(page.next);
    for (const userId of spent.keys()) touched.add(userId);
    if (page.requests.length < PAGE) break;
  }

  for (const userId of touched) {
    await syncAiCap(userId).catch((error) => console.error(`AI spend cap sync failed (${userId}):`, error));
  }
  return `${billed} request(s) billed across ${touched.size} wallet(s)`;
}

/** Every payer's cap again — after the rate or markup changes. */
export async function syncAllAiCaps() {
  const accounts = await prisma.aiAccount.findMany({ select: { userId: true } });
  let failed = 0;
  for (const { userId } of accounts) await syncAiCap(userId).catch(() => failed++);
  return { total: accounts.length, failed };
}
