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

/** Until the superadmin sets them: market IDR per USD, and the one markup over it. */
export const DEFAULT_RATE = 18_200;
export const DEFAULT_MARKUP = 1.044;

export type AiPricing = { rate: number; markup: number };

export async function aiPricing(): Promise<AiPricing> {
  const [rate, markup] = await Promise.all([getLarikaAiValue('rate'), getLarikaAiValue('markup')]);
  return { rate: Number(rate) || DEFAULT_RATE, markup: Number(markup) || DEFAULT_MARKUP };
}

/** rate × markup, ×10⁴ so the money math stays in BigInt. */
const SCALE = 10_000n;
export const factorOf = ({ rate, markup }: AiPricing) => BigInt(Math.round(rate * markup * 10_000));

/** A buy cost (micro-USD) → what the workspace pays (micro-IDR), rounded up. micro-USD × IDR/USD = micro-IDR. */
export const chargeFor = (costMicroUsd: bigint, factor: bigint) => (costMicroUsd * factor + SCALE - 1n) / SCALE;

/** What a balance (micro-IDR) buys at buy price (micro-USD), rounded down. Nothing when it is not positive. */
export const buyableWith = (balanceMicroIdr: bigint, factor: bigint) => (balanceMicroIdr > 0n ? (balanceMicroIdr * SCALE) / factor : 0n);

/** A buy price (USD per 1M tokens) as we sell it (IDR per 1M tokens). */
export const sellPerMillion = (usdPerMillion: number, p: AiPricing) => usdPerMillion * p.rate * p.markup;

// ── Spend cap ──

/**
 * Tell the gateway how far the workspace may go: what was billed so far plus what
 * the balance buys. One statement reads both, so a billing run in between cannot
 * pair an old balance with a new billed total.
 */
export async function syncAiCap(organizationId: string) {
  const [row] = await prisma.$queryRaw<Array<{ accountId: string; billedSpent: bigint; balance: bigint }>>`
    SELECT a."accountId", a."billedSpent", coalesce(w.balance, 0)::bigint AS balance
    FROM ai_accounts a LEFT JOIN wallets w ON w."organizationId" = a."organizationId"
    WHERE a."organizationId" = ${organizationId}`;
  if (!row) return;
  const cap = row.billedSpent + buyableWith(row.balance, factorOf(await aiPricing()));
  await aiGateway(`/admin/accounts/${row.accountId}`, { method: 'PATCH', body: { spendCap: cap.toString() } });
}

// ── Billing ──

type FeedRequest = { id: string; accountId: string; model: string; cost: string; createdAt: string };
const PAGE = 1000;
/** Serialises billing runs across processes; the cursor is re-checked under it. */
const BILLING_LOCK = 7_431_001;

/**
 * Charge what the gateway metered since the last run: its request feed, read from
 * our cursor, priced `buy × rate × markup`, added to one wallet entry per workspace,
 * WIB day and model. Each page is one transaction that also moves the cursor, so a
 * crash re-reads the page and nothing is charged twice. Then each workspace billed
 * gets its new spend cap.
 */
export async function billAiUsage(): Promise<string> {
  if (!(await getLarikaAiConfig())) return 'skipped — the AI gateway is not set up';
  const factor = factorOf(await aiPricing());
  const owners = new Map((await prisma.aiAccount.findMany({ select: { organizationId: true, accountId: true } })).map((a) => [a.accountId, a.organizationId]));
  let cursor = (await getLarikaAiValue('cursor')) ?? '0';
  const touched = new Set<string>();
  let billed = 0;

  for (;;) {
    const page = await aiGateway<{ requests: FeedRequest[]; next: string }>(`/admin/requests?after=${cursor}&limit=${PAGE}`);
    if (!page.requests.length) break;

    const entries = new Map<string, { organizationId: string; amount: bigint; note: string }>();
    const spent = new Map<string, bigint>();
    for (const r of page.requests) {
      // an account made on the gateway's own dashboard belongs to no workspace
      const organizationId = owners.get(r.accountId);
      const cost = BigInt(r.cost);
      if (!organizationId || cost === 0n) continue;
      const day = new Date(new Date(r.createdAt).getTime() + WIB_MS).toISOString().slice(0, 10);
      const ref = `ai:${organizationId}:${day}:${r.model}`;
      // larika-optima's classifier call: its own line, "routing"
      const label = r.model.endsWith(':router') ? `routing (${r.model.slice(0, -':router'.length)})` : r.model;
      const entry = entries.get(ref) ?? { organizationId, amount: 0n, note: `AI · ${label} · ${day}` };
      entry.amount += chargeFor(cost, factor);
      entries.set(ref, entry);
      spent.set(organizationId, (spent.get(organizationId) ?? 0n) + cost);
      billed++;
    }

    const from = cursor;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BILLING_LOCK})`;
      const stored = await tx.integrationConfig.findUnique({ where: { provider_key: { provider: 'larika_ai', key: 'cursor' } } });
      if ((stored?.value ?? '0') !== from) throw new Error('AI billing: the cursor moved under this run — another run billed this page');
      for (const [ref, e] of entries) {
        await tx.walletEntry.upsert({
          where: { ref },
          create: { ref, organizationId: e.organizationId, kind: 'AI_USAGE', amount: -e.amount, note: e.note },
          update: { amount: { decrement: e.amount } },
        });
        await tx.wallet.upsert({
          where: { organizationId: e.organizationId },
          create: { organizationId: e.organizationId, balance: -e.amount },
          update: { balance: { decrement: e.amount } },
        });
      }
      for (const [organizationId, cost] of spent) {
        await tx.aiAccount.update({ where: { organizationId }, data: { billedSpent: { increment: cost } } });
      }
      await tx.integrationConfig.upsert({
        where: { provider_key: { provider: 'larika_ai', key: 'cursor' } },
        create: { provider: 'larika_ai', key: 'cursor', value: String(page.next) },
        update: { value: String(page.next) },
      });
    });
    cursor = String(page.next);
    for (const organizationId of spent.keys()) touched.add(organizationId);
    if (page.requests.length < PAGE) break;
  }

  for (const organizationId of touched) {
    await syncAiCap(organizationId).catch((error) => console.error(`AI spend cap sync failed (${organizationId}):`, error));
  }
  return `${billed} request(s) billed across ${touched.size} workspace(s)`;
}

/** Every workspace's cap again — after the rate or markup changes. */
export async function syncAllAiCaps() {
  const accounts = await prisma.aiAccount.findMany({ select: { organizationId: true } });
  let failed = 0;
  for (const { organizationId } of accounts) await syncAiCap(organizationId).catch(() => failed++);
  return { total: accounts.length, failed };
}
