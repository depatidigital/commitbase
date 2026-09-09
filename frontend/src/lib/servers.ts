import apiRequest from './api';
import { ListParams, listQuery } from './admin';
import type { Paginated } from '@/components/DataTable';
import type { Organization } from './organizations';

export type ServerStatus = 'ONLINE' | 'OFFLINE' | 'UNKNOWN';

export interface Server {
  id: string;
  name: string;
  hostname: string;
  sshUser: string;
  sshPort: number;
  sshKeyPath: string;
  publicIp: string;
  caddyApiUrl: string;
  status: ServerStatus;
  lastSeenAt: string | null;
  lastError: string | null;
  createdAt: string;
  _count: { organizations: number };
}

export interface ServerDetail extends Server {
  organizations: Array<{ id: string; name: string; slug: string }>;
}

export type ServerInput = {
  name: string;
  hostname: string;
  sshUser: string;
  sshPort: number;
  sshKeyPath: string;
  publicIp: string;
  caddyApiUrl: string;
};

const unwrap = <T>(res: { success: boolean; data?: T; error?: string }, fallback: string): T => {
  if (res.success) return res.data as T;
  throw new Error(res.error || fallback);
};

export const getServers = async (): Promise<Server[]> =>
  unwrap(await apiRequest<Server[]>('/servers'), 'Failed to fetch servers');

export const getServersPage = async (params: ListParams): Promise<Paginated<Server>> =>
  unwrap(await apiRequest<Paginated<Server>>(`/servers${listQuery(params)}`), 'Failed to fetch servers');

export const getServer = async (id: string): Promise<ServerDetail> =>
  unwrap(await apiRequest<ServerDetail>(`/servers/${id}`), 'Failed to fetch server');

export const createServer = async (data: ServerInput): Promise<Server> =>
  unwrap(await apiRequest<Server>('/servers', { method: 'POST', body: JSON.stringify(data) }), 'Failed to register server');

export const updateServer = async (id: string, data: Partial<ServerInput>): Promise<Server> =>
  unwrap(await apiRequest<Server>(`/servers/${id}`, { method: 'PUT', body: JSON.stringify(data) }), 'Failed to update server');

export const deleteServer = async (id: string) =>
  unwrap(await apiRequest(`/servers/${id}`, { method: 'DELETE' }), 'Failed to delete server');

export const pingServer = async (
  id: string
): Promise<{ id: string; name: string; status: ServerStatus; error?: string }> =>
  unwrap(await apiRequest(`/servers/${id}/ping`, { method: 'POST' }), 'Failed to reach server');

/** Place an organization on a node. `null` unplaces it. */
export const setOrganizationServer = async (orgId: string, serverId: string | null): Promise<Organization> =>
  unwrap(
    await apiRequest<Organization>(`/organizations/${orgId}/server`, {
      method: 'PUT',
      body: JSON.stringify({ serverId }),
    }),
    'Failed to place organization'
  );
