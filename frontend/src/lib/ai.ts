import apiRequest from './api';
import { locale, t } from './i18n';

/** A workspace's AI API (OpenAI-compatible, on the AI gateway) and the rupiah wallet it is charged to. */

const unwrap = <T>(res: { success: boolean; data?: T; error?: string }, fallback: string): T => {
  if (res.success) return res.data as T;
  throw new Error(res.error || fallback);
};

const post = (body?: unknown) => ({ method: 'POST', ...(body !== undefined && { body: JSON.stringify(body) }) });

/** micro-rupiah (a string: BigInt on the server) → rupiah */
export const fromMicro = (micro: string | number) => Number(micro) / 1e6;
/** rupiah, with cents only when a sum is below one rupiah's worth of precision (AI calls cost fractions) */
export const rupiah = (value: number, fraction = false) =>
  new Intl.NumberFormat(locale, { style: 'currency', currency: 'IDR', minimumFractionDigits: 0, maximumFractionDigits: fraction ? 2 : 0 }).format(value);

export type KeyPeriod = 'DAY' | 'MONTH';

export interface AiKey {
  id: string;
  name: string;
  /** micro-IDR at today's rate: what it spent this day or month, and its limit for one (null = none) */
  spent: string;
  spendCap: string | null;
  /** the limit's period, WIB */
  capPeriod: KeyPeriod;
  prefix: string;
  rpm: number;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface AiOverview {
  /** the platform has an AI gateway set up */
  configured: boolean;
  /** what apps call: …/v1 */
  baseUrl: string | null;
  organizationId: string;
  /** micro-IDR: the payer's balance, shared by every workspace they pay for */
  balance: string;
  /** who pays this workspace */
  payer: { name: string | null; email: string } | null;
  hasAccount: boolean;
  suspended: boolean;
  keys: AiKey[];
  gatewayError: string | null;
}

/** IDR per 1M tokens; a tier covers prompts up to `upTo` tokens (null = the rest). */
export interface AiModelPrice {
  id: string;
  contextWindow: number;
  /** priced higher in the provider's peak hours */
  peak: boolean;
  tiers: Array<{ upTo: number | null; input: number; cacheRead: number; cacheWrite: number; output: number }>;
}

export const getAi = async () => unwrap(await apiRequest<AiOverview>('/ai'), t('Failed to fetch the AI API'));
export const enableAi = async () => unwrap(await apiRequest('/ai/account', post()), t('Failed to turn the AI API on'));
/** limit: whole rupiah per period; null lifts it */
export const setAiKeyLimit = async (id: string, limit: number | null, period: KeyPeriod) =>
  unwrap(await apiRequest(`/ai/keys/${id}`, { method: 'PATCH', body: JSON.stringify({ limit, period }) }), t('Failed to change the limit'));
export const createAiKey = async (body: { name: string; rpm?: number; limit?: number; period?: KeyPeriod }) =>
  unwrap(await apiRequest<AiKey & { key: string }>('/ai/keys', post(body)), t('Failed to create an API key'));
export const revokeAiKey = async (id: string) => unwrap(await apiRequest(`/ai/keys/${id}`, { method: 'DELETE' }), t('Failed to revoke the key'));
export const getAiModels = async () => unwrap(await apiRequest<AiModelPrice[]>('/ai/models'), t('Failed to fetch the AI models'));


// ── Superadmin ──

export interface AiGatewayConfig {
  baseUrl: string;
  adminKeySet: boolean;
  adminPathSet: boolean;
  /** IDR per USD, market */
  rate: number;
  /** one factor over buy price × rate */
  markup: number;
  /** after a save: null when the gateway took the key, else why not */
  check?: string | null;
}

export interface WalletRow {
  userId: string;
  name: string;
  email: string;
  /** micro-IDR */
  balance: string;
  updatedAt: string | null;
  aiAccountId: string | null;
}

export const getAiGatewayConfig = async () => unwrap(await apiRequest<AiGatewayConfig>('/ai-gateway/config'), t('Failed to fetch the AI gateway settings'));
export const saveAiGatewayConfig = async (body: { baseUrl?: string; adminKey?: string; adminPath?: string; rate?: number; markup?: number }) =>
  unwrap(await apiRequest<AiGatewayConfig>('/ai-gateway/config', { method: 'PUT', body: JSON.stringify(body) }), t('Failed to save the AI gateway settings'));
export const getWallets = async () => unwrap(await apiRequest<WalletRow[]>('/ai-gateway/wallets'), t('Failed to fetch the wallets'));
export const creditWallet = async (body: { userId: string; amount: number; note: string }) =>
  unwrap(await apiRequest('/ai-gateway/credit', post(body)), t('Failed to credit the wallet'));
export const setAiSuspended = async (userId: string, disabled: boolean) =>
  unwrap(await apiRequest(`/ai-gateway/accounts/${userId}`, { method: 'PATCH', body: JSON.stringify({ disabled }) }), t('Failed to change the AI API'));
