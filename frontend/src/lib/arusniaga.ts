import apiRequest from './api';
import { t } from './i18n';

/** ArusNiaga (erp.depatidigital.com): where Larika's invoices — top-ups — are issued. */

const unwrap = <T>(res: { success: boolean; data?: T; error?: string }, fallback: string): T => {
  if (res.success) return res.data as T;
  throw new Error(res.error || fallback);
};

export interface TopUp {
  id: string;
  organizationId: string;
  /** micro-IDR the wallet gets */
  amount: string;
  /** PENDING | PAID | CANCELLED | EXPIRED */
  status: string;
  invoiceRef: string | null;
  /** ArusNiaga's invoice page: where it is paid */
  invoiceUrl: string | null;
  /** rupiah the invoice asks for */
  invoiceTotal: number | null;
  createdAt: string;
  paidAt: string | null;
}

// ── Workspace ──

export interface TopUps {
  /** ArusNiaga is set up: top-ups are open */
  enabled: boolean;
  min: number;
  max: number;
  topUps: TopUp[];
}

export const getTopUps = async () => unwrap(await apiRequest<TopUps>('/billing/topups'), t('Could not read the top-ups'));
export const createTopUp = async (amount: number) =>
  unwrap(await apiRequest<TopUp>('/billing/topups', { method: 'POST', body: JSON.stringify({ amount }) }), t('Could not create the top-up'));

// ── Superadmin ──

export interface ArusniagaConfig {
  baseUrl: string;
  apiKeySet: boolean;
  /** the business the key issues invoices for — null when not set or not reachable */
  business: string | null;
  /** why the check call failed */
  error: string | null;
}

export const getArusniagaConfig = async () => unwrap(await apiRequest<ArusniagaConfig>('/arusniaga/config'), t('Failed to fetch the ArusNiaga settings'));
export const saveArusniagaConfig = async (body: { baseUrl?: string; apiKey?: string }) =>
  unwrap(await apiRequest<ArusniagaConfig>('/arusniaga/config', { method: 'PUT', body: JSON.stringify(body) }), t('Failed to save the ArusNiaga settings'));
export const getAllTopUps = async () => unwrap(await apiRequest<Array<TopUp & { organizationName: string }>>('/arusniaga/topups'), t('Could not read the top-ups'));
export const checkTopUpsNow = async () => unwrap(await apiRequest<{ summary: string }>('/arusniaga/topups/check', { method: 'POST' }), t('The check failed'));
