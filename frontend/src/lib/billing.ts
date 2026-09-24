import apiRequest from './api';
import { t } from './i18n';

/** A workspace's metered use in a month and what it costs — pay for what you use. */
export interface Usage {
  month: string;
  rates: { cpuCoreHour: number; memGbHour: number; storageGbHour: number; currency: string };
  usage: { cpuCoreHours: number; memGbHours: number; storageGbHours: number };
  cost: { cpu: number; mem: number; storage: number; total: number };
  /** where the month is heading at this pace — only while it runs */
  projected: number | null;
  days: Array<{ date: string; cost: number }>;
}

export const getUsage = async (month?: string): Promise<Usage> => {
  const response = await apiRequest<Usage>(`/billing/usage${month ? `?month=${encodeURIComponent(month)}` : ''}`);
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Could not read the usage'));
};
