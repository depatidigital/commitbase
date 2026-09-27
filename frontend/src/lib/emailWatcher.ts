import apiRequest from './api';
import { locale, t } from '@/lib/i18n';
import type { Paginated } from '@/components/DataTable';

/** Email Watcher ("Pantau Email"): watched mailboxes, their rules, the emails the rules matched. */

const unwrap = <T>(res: { success: boolean; data?: T; error?: string }, fallback: string): T => {
  if (res.success) return res.data as T;
  throw new Error(res.error || fallback);
};

export const MAILBOXES_KEY = ['email-watcher', 'mailboxes'];
export const RULES_KEY = ['email-watcher', 'rules'];
export const EVENTS_KEY = ['email-watcher', 'events'];

export const when = (at: string | null) => (at ? new Date(at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

const send = (method: string, body?: unknown) => ({ method, ...(body !== undefined && { body: JSON.stringify(body) }) });

export type MailboxStatus = 'OK' | 'AUTH_FAILED' | 'ERROR' | 'PAUSED';

export interface Mailbox {
  id: string;
  email: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  status: MailboxStatus;
  lastError: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  organization: { id: string; name: string } | null;
  canManage: boolean;
  rules?: number;
  /** rules switched on — none: not connected */
  activeRules?: number;
}

export type FieldType = 'text' | 'amount';
export interface RuleField {
  name: string;
  pattern: string;
  type: FieldType;
}

export type ConditionField = 'from' | 'subject' | 'body';
export type ConditionOp = 'contains' | 'not_contains' | 'equals' | 'in' | 'not_in' | 'regex';
/** in / not_in: a comma-separated list, any of which may appear. Case-insensitive throughout. */
export interface Condition {
  field: ConditionField;
  op: ConditionOp;
  value: string;
}

export interface Rule {
  id: string;
  name: string;
  /** all: every condition (AND); any: one is enough (OR) */
  match: 'all' | 'any';
  conditions: Condition[];
  onlyVerified: boolean;
  fields: RuleField[];
  webhookUrl: string | null;
  webhookSecret: string;
  waNumberId: string | null;
  waTo: string | null;
  waTemplate: string | null;
  active: boolean;
  mailboxId: string;
  mailbox: { id: string; email: string; organizationId: string };
}

/** The Rules tab: every rule of the mailboxes the caller manages, and the WhatsApp numbers a rule may send from. */
export interface RulesOverview {
  rules: Rule[];
  waNumbers: Array<{ id: string; name: string; organizationId: string }>;
  retentionDays: number;
}

export type RuleInput = Omit<Rule, 'id' | 'webhookSecret' | 'mailboxId' | 'mailbox'>;

export interface PreviewRow {
  uid: number;
  date: string;
  from: string;
  subject: string;
  verified: boolean;
  /** the whole rule takes it — the header already let it through */
  matched: boolean;
  /** the text body, as the fields read it (after the subject line) */
  text: string;
  data: Record<string, string | number | null>;
}

export type EventStatus = 'PENDING' | 'DELIVERED' | 'FAILED' | 'SKIPPED' | 'NO_TARGET';

export interface MailEvent {
  id: string;
  rule: { id: string; name: string; mailbox: { email: string } };
  from: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  verified: boolean;
  data: Record<string, string | number | null>;
  status: EventStatus;
  attempts: number;
  nextAttemptAt: string | null;
  error: string | null;
  createdAt: string;
}

export interface Detected {
  host: string;
  port: number;
  secure: boolean;
  provider: string | null;
  unsupported?: string;
}

export const detectMailbox = async (email: string) =>
  unwrap(await apiRequest<Detected>(`/email-watcher/detect?email=${encodeURIComponent(email)}`), t('Could not look up the mail server'));

export const getMailboxes = async () => unwrap(await apiRequest<Mailbox[]>('/email-watcher/mailboxes'), t('Failed to fetch mailboxes'));

export const addMailbox = async (body: { organizationId?: string; email: string; host: string; port: number; secure: boolean; username: string; password: string }) =>
  unwrap(await apiRequest<{ id: string }>('/email-watcher/mailboxes', send('POST', body)), t('Failed to add the mailbox'));

export const getRules = async () => unwrap(await apiRequest<RulesOverview>('/email-watcher/rules'), t('Failed to fetch the rules'));

export const getRule = async (id: string) =>
  unwrap(await apiRequest<Rule & { waNumbers: RulesOverview['waNumbers'] }>(`/email-watcher/rules/${id}`), t('Failed to fetch the rule'));

export const updateMailbox = async (id: string, body: Partial<{ host: string; port: number; secure: boolean; username: string; password: string; paused: boolean }>) =>
  unwrap(await apiRequest(`/email-watcher/mailboxes/${id}`, send('PATCH', body)), t('Failed to update the mailbox'));

export const deleteMailbox = async (id: string) => unwrap(await apiRequest(`/email-watcher/mailboxes/${id}`, send('DELETE')), t('Failed to delete the mailbox'));

export const previewRule = async (mailboxId: string, rule: Pick<RuleInput, 'match' | 'conditions' | 'fields'> & { days?: number; limit?: number }) =>
  unwrap(await apiRequest<{ rows: PreviewRow[] }>(`/email-watcher/mailboxes/${mailboxId}/preview`, send('POST', rule)), t('Failed to try the rule'));

export const createRule = async (mailboxId: string, rule: Partial<RuleInput> & { name: string }) =>
  unwrap(await apiRequest<Rule & { warning?: string }>(`/email-watcher/mailboxes/${mailboxId}/rules`, send('POST', rule)), t('Failed to save the rule'));

export const updateRule = async (id: string, rule: Partial<RuleInput> & { newSecret?: boolean }) =>
  unwrap(await apiRequest<Rule & { warning?: string }>(`/email-watcher/rules/${id}`, send('PATCH', rule)), t('Failed to save the rule'));

export const deleteRule = async (id: string) => unwrap(await apiRequest(`/email-watcher/rules/${id}`, send('DELETE')), t('Failed to delete the rule'));

export const getEvents = async (params: { page: number; limit: number; search: string }) =>
  unwrap(
    await apiRequest<Paginated<MailEvent>>(`/email-watcher/events?${new URLSearchParams({ page: String(params.page), limit: String(params.limit), search: params.search })}`),
    t('Failed to fetch events'),
  );

export const replayEvent = async (id: string) => unwrap(await apiRequest<MailEvent>(`/email-watcher/events/${id}/replay`, send('POST')), t('Failed to send the event again'));
