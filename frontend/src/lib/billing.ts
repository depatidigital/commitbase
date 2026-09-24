import apiRequest from './api';
import { t } from './i18n';

/** A workspace's metered use in a month and what it costs — pay for what you use. */
export interface Usage {
  month: string;
  rates: { cpuCoreHour: number; memGbHour: number; storageGbHour: number; currency: string };
  usage: { cpuCoreHours: number; memGbHours: number; storageGbHours: number };
  cost: { cpu: number; mem: number; storage: number; total: number };
  /** the month so far plus what is held now for the hours left — only while the month runs */
  projected: number | null;
  /** what it holds now and costs per hour: the estimate's pace (current month only) */
  rate: { storageGb: number; memGb: number; cpuCores: number; perHour: number } | null;
  days: Array<{ date: string; cost: number }>;
}

export const getUsage = async (month?: string): Promise<Usage> => {
  const response = await apiRequest<Usage>(`/billing/usage${month ? `?month=${encodeURIComponent(month)}` : ''}`);
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Could not read the usage'));
};
