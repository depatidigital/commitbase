import apiRequest from './api';
import { t } from './i18n';

/** A workspace's metered use in a month and what it costs — pay for what you use. */
export interface Usage {
  month: string;
  /** CPU and memory by the hour; storage by the GB-month, charged per day (the month's price over its days) */
  /** CPU and memory by the hour; disk and object storage (R2) by the GB-month, charged per day */
  rates: { cpuCoreHour: number; memGbHour: number; storageGbMonth: number; objectGbMonth: number; currency: string };
  usage: { cpuCoreHours: number; memGbHours: number; storageGbDays: number; objectGbDays: number };
  monthDays: number;
  cost: { cpu: number; mem: number; storage: number; object: number; total: number };
  /** the month so far plus what is held now for the hours left — only while the month runs */
  projected: number | null;
  /** what it holds now and costs per hour: the estimate's pace (current month only) */
  rate: { storageGb: number; objectGb: number; journalGb: number; memGb: number; cpuCores: number; perHour: number } | null;
  days: Array<{ date: string; cost: number }>;
}

export const getUsage = async (month?: string): Promise<Usage> => {
  const response = await apiRequest<Usage>(`/billing/usage${month ? `?month=${encodeURIComponent(month)}` : ''}`);
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Could not read the usage'));
};

/** The price list (Pricing page): apps metered by the hour and GB, WhatsApp numbers by the day and message. */
export interface Rates {
  apps: { cpuCoreHour: number; memGbHour: number; storageGbMonth: number; objectGbMonth: number; currency: string };
  wa: { linkedDay: number; freeTextsPerDay: number; textAfterFree: number; media: number; ownNodeMonth: number; currency: string };
}

export const getRates = async (): Promise<Rates> => {
  const response = await apiRequest<Rates>('/billing/rates');
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Could not read the prices'));
};

/** The workspace's wallet: balance, pace, the limit its apps stop at, and who pays. Money is micro-IDR, as strings. */
export interface Wallet {
  organizationId: string;
  balance: string;
  /** what it costs a day now */
  perDay: string;
  /** until zero, and until the apps stop; null when nothing is spent */
  daysLeft: number | null;
  daysUntilStop: number | null;
  /** how far below zero it may go: 7 days of spend, at least Rp 10,000 */
  limit: string;
  /** its apps stopped for the balance */
  suspendedAt: string | null;
  /** the first day hosting is charged; null: not charged yet */
  hostingBilledFrom: string | null;
  billingUser: { id: string; name: string | null; email: string } | null;
  owners: Array<{ id: string; name: string | null; email: string }>;
  canChangeBillingUser: boolean;
}

export const getWallet = async (): Promise<Wallet> => {
  const response = await apiRequest<Wallet>('/billing/wallet');
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Could not read the balance'));
};

export const setBillingUser = async (organizationId: string, userId: string) => {
  const response = await apiRequest(`/organizations/${organizationId}/billing-user`, { method: 'PUT', body: JSON.stringify({ userId }) });
  if (!response.success) throw new Error(response.error || t('Could not change who pays'));
};

export interface WalletEntry {
  id: string;
  /** TOPUP | ADJUST | WELCOME | REFUND | AI_USAGE | HOSTING_USAGE | DOMAIN */
  kind: string;
  /** micro-IDR, signed */
  amount: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export const getWalletEntries = async (month?: string) => {
  const response = await apiRequest<{ month: string; entries: WalletEntry[] }>(`/billing/entries${month ? `?month=${encodeURIComponent(month)}` : ''}`);
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Failed to fetch the balance history'));
};
