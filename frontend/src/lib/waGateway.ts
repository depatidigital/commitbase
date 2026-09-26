import apiRequest from './api';
import { t } from '@/lib/i18n';

/** The Larika WhatsApp gateway: its settings and WA nodes (superadmin), and a workspace's numbers. */

const unwrap = <T>(res: { success: boolean; data?: T; error?: string }, fallback: string): T => {
  if (res.success) return res.data as T;
  throw new Error(res.error || fallback);
};

const post = (body?: unknown) => ({ method: 'POST', ...(body !== undefined && { body: JSON.stringify(body) }) });

export type NumberStatus = 'CONNECTING' | 'QR' | 'ONLINE' | 'OFFLINE' | 'MISSING';

export interface GatewayConfig {
  baseUrl: string;
  adminKeySet: boolean;
  adminPathSet: boolean;
  /** after a save: null when the gateway took the key, else why not */
  check?: string | null;
}

export interface WaNode {
  id: string;
  name: string;
  capacity: number;
  version: string | null;
  lastSeenAt: string | null;
  paired: boolean;
  diskBytes: number | null;
  /** an unused permanent connect string is waiting */
  permanent: boolean;
  instances: number;
  online: boolean;
}

export interface PairResult {
  id: string;
  permanent: boolean;
  connect: string;
  pairCode?: string;
  pairExpiresAt?: string;
}

export interface WaNumber {
  id: string;
  name: string;
  organization: { id: string; name: string };
  createdAt: string;
  canManage: boolean;
  /** null: the gateway could not be asked */
  status: NumberStatus | null;
  phone: string | null;
  error: string | null;
  sent24h: number;
  nodeName: string | null;
  nodeOnline: boolean;
  webhookUrl: string | null;
  ipAllowlist: string[];
}

export interface WaNumberDetail {
  id: string;
  instanceId: string;
  name: string;
  canManage: boolean;
  status: NumberStatus;
  qr: string | null;
  phone: string | null;
  profileName: string | null;
  error: string | null;
  webhookUrl: string | null;
  ipAllowlist: string[];
  usage: { dailyCap: number; sent24h: number; queued: number } | null;
  gatewayUrl: string;
}

export interface WaKey {
  id: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export const getGatewayConfig = async () => unwrap(await apiRequest<GatewayConfig>('/larika-gateway/config'), t('Failed to fetch gateway settings'));
export const saveGatewayConfig = async (body: { baseUrl?: string; adminKey?: string; adminPath?: string }) =>
  unwrap(await apiRequest<GatewayConfig>('/larika-gateway/config', { method: 'PUT', body: JSON.stringify(body) }), t('Failed to save gateway settings'));

export const getWaNodes = async () => unwrap(await apiRequest<WaNode[]>('/larika-gateway/nodes'), t('Failed to fetch WA nodes'));
export const pairWaNode = async (body: { name: string; permanent: boolean; agentId?: string }) =>
  unwrap(await apiRequest<PairResult>('/larika-gateway/nodes/pair', post(body)), t('Failed to pair the node'));
export const getWaNodeConnect = async (id: string) =>
  unwrap(await apiRequest<{ connect: string }>(`/larika-gateway/nodes/${id}/connect`), t('Failed to fetch the connect string'));
export const revokeWaNode = async (id: string) => unwrap(await apiRequest(`/larika-gateway/nodes/${id}/revoke`, post()), t('Failed to revoke the node'));
export const deleteWaNode = async (id: string) => unwrap(await apiRequest(`/larika-gateway/nodes/${id}`, { method: 'DELETE' }), t('Failed to delete the node'));
export const updateWaNodes = async (agentId?: string) => unwrap(await apiRequest('/larika-gateway/nodes/update', post({ agentId })), t('Failed to ask the nodes to update'));

export const getWaNumbers = async () => {
  const res = await apiRequest<WaNumber[]>('/wa-numbers');
  // the list comes back even when the gateway is down; error says why the status is missing
  return { rows: unwrap(res, t('Failed to fetch WhatsApp numbers')), gatewayError: res.error ?? null };
};
export const createWaNumber = async (body: { name: string; organizationId?: string; ipAllowlist: string; webhookUrl?: string }) =>
  unwrap(await apiRequest<{ id: string; apiKey: string | null }>('/wa-numbers', post(body)), t('Failed to add the number'));
export const getWaNumber = async (id: string) => unwrap(await apiRequest<WaNumberDetail>(`/wa-numbers/${id}`), t('Failed to fetch the number'));
export const updateWaNumber = async (id: string, body: { name?: string; ipAllowlist?: string; webhookUrl?: string }) =>
  unwrap(await apiRequest(`/wa-numbers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }), t('Failed to save the number'));
export const relinkWaNumber = async (id: string) => unwrap(await apiRequest(`/wa-numbers/${id}/relink`, post()), t('Failed to relink the number'));
export const restartWaNumber = async (id: string) => unwrap(await apiRequest(`/wa-numbers/${id}/restart`, post()), t('Failed to restart the number'));
export const deleteWaNumber = async (id: string) => unwrap(await apiRequest(`/wa-numbers/${id}`, { method: 'DELETE' }), t('Failed to delete the number'));
export const getWaKeys = async (id: string) => unwrap(await apiRequest<WaKey[]>(`/wa-numbers/${id}/keys`), t('Failed to fetch API keys'));
export const createWaKey = async (id: string) => unwrap(await apiRequest<{ apiKey: string }>(`/wa-numbers/${id}/keys`, post()), t('Failed to create an API key'));
export const revokeWaKey = async (id: string, keyId: string) =>
  unwrap(await apiRequest(`/wa-numbers/${id}/keys/${keyId}`, { method: 'DELETE' }), t('Failed to revoke the key'));
export const getWebhookSecret = async (id: string) =>
  unwrap(await apiRequest<{ webhookSecret: string }>(`/wa-numbers/${id}/webhook-secret`), t('Failed to fetch the webhook secret'));
export const rotateWebhookSecret = async (id: string) =>
  unwrap(await apiRequest<{ webhookSecret: string }>(`/wa-numbers/${id}/webhook-secret`, post()), t('Failed to rotate the webhook secret'));
