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
