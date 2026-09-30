import apiRequest from './api';
import { t } from './i18n';

/** The Stalwart mail server: its outgoing queue by sender, locking a leaked account, its log per day. Superadmin only. */

const unwrap = <T>(res: { success: boolean; data?: T; error?: string }, fallback: string): T => {
  if (res.success) return res.data as T;
  throw new Error(res.error || fallback);
};

export interface StalwartConfig {
  baseUrl: string;
  username: string;
  passwordSet: boolean;
  /** the node Stalwart runs on: its log is read there */
  server: { id: string; name: string } | null;
  logDir: string;
  /** messages from one sender in the queue before the admins are mailed */
  alertThreshold: number;
  /** why the admin call failed, null when it worked */
  error: string | null;
}

export type StalwartConfigInput = Partial<{ baseUrl: string; username: string; password: string; serverId: string; logDir: string; alertThreshold: number }>;

export interface QueueSender {
  sender: string;
  messages: number;
  recipients: number;
  /** where it was handed in from, top five */
  ips: Array<{ ip: string; messages: number }>;
  oldest: string;
}

export interface LogSender {
  sender: string;
  messages: number;
  recipients: number;
  lines: number;
}

export const getStalwartConfig = async () => unwrap(await apiRequest<StalwartConfig>('/stalwart/config'), t('Could not read the Stalwart settings'));
export const saveStalwartConfig = async (input: StalwartConfigInput) =>
  unwrap(await apiRequest<StalwartConfig>('/stalwart/config', { method: 'PUT', body: JSON.stringify(input) }), t('Could not save the Stalwart settings'));
export const getMailQueue = async () => unwrap(await apiRequest<{ total: number; senders: QueueSender[] }>('/stalwart/queue'), t('Could not read the mail queue'));
export const cancelMailQueue = async (sender: string) =>
  unwrap(await apiRequest<{ cancelled: number }>('/stalwart/queue/cancel', { method: 'POST', body: JSON.stringify({ sender }) }), t('Could not cancel the queue'));
export const lockMailAccount = async (email: string) =>
  unwrap(await apiRequest<{ id: string; email: string }>('/stalwart/accounts/lock', { method: 'POST', body: JSON.stringify({ email }) }), t('Could not lock the account'));
export const getLogSenders = async (day: string) =>
  unwrap(await apiRequest<LogSender[]>(`/stalwart/log-senders?day=${encodeURIComponent(day)}`), t('Could not read the log'));
