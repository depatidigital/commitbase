import apiRequest from './api';
import { ListParams, listQuery } from './admin';
import type { Paginated } from '@/components/DataTable';
import type { Organization } from './organizations';

export type ServerStatus = 'ONLINE' | 'OFFLINE' | 'UNKNOWN';

/** How the control plane authenticates to a node. Keys are the default. */
export type AuthMethod = 'KEY' | 'PASSWORD';

export interface Server {
  id: string;
  name: string;
  hostname: string;
  sshUser: string;
  sshPort: number;
  authMethod: AuthMethod;
  sshKeyPath: string | null;
  /** The password itself never leaves the backend — only whether one is stored. */
  hasPassword: boolean;
  publicIp: string;
  tags: string[];
  status: ServerStatus;
  /** Runner scripts installed? A node can be reachable and still not set up. */
  provisioned: boolean;
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
  authMethod: AuthMethod;
  sshKeyPath?: string;
  /** Sent only when set; an empty value on edit keeps the stored one. */
  sshPassword?: string;
  publicIp: string;
  tags: string[];
};

const unwrap = <T>(res: { success: boolean; data?: T; error?: string }, fallback: string): T => {
  if (res.success) return res.data as T;
  throw new Error(res.error || fallback);
};

export const getServers = async (): Promise<Server[]> =>
  unwrap(await apiRequest<Server[]>('/servers'), 'Failed to fetch servers');

export const getServersPage = async (
  params: ListParams,
  tag = '',
): Promise<Paginated<Server>> =>
  unwrap(
    await apiRequest<Paginated<Server>>(
      `/servers${listQuery(params)}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}`,
    ),
    'Failed to fetch servers',
  );

export type LogSource = 'errors' | 'system' | 'caddy' | 'ssh' | 'php' | 'apps';

export const getServerLogs = async (
  id: string,
  source: LogSource,
  lines = 200,
): Promise<{ source: LogSource; lines: number; output: string }> =>
  unwrap(
    await apiRequest(`/servers/${id}/logs?source=${source}&lines=${lines}`),
    'Failed to read server logs',
  );

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
): Promise<{ id: string; name: string; status: ServerStatus; provisioned: boolean; error?: string }> =>
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

/** One hostname this node's Caddy is serving, as the route describes it. */
export interface CaddySite {
  host: string;
  kind: 'NODEJS' | 'PHP' | 'STATIC' | 'OTHER';
  port: number | null;
  rootPath: string | null;
  socket: string | null;
  origin: string | null;
  /** false for the wildcard and the panel itself — routes, but not apps */
  managed: boolean;
}

export const getServerCaddySites = async (id: string): Promise<CaddySite[]> =>
  unwrap(await apiRequest<CaddySite[]>(`/servers/${id}/caddy/routes`), 'Failed to read Caddy routes');

export interface ServerApp {
  id: string;
  name: string;
  domain: string;
  type: string;
  status: string;
  port: number | null;
  runtime: string | null;
  lastDeployment: string | null;
  organization: { id: string; name: string; slug: string } | null;
}

export const getServerApps = async (id: string): Promise<ServerApp[]> =>
  unwrap(await apiRequest<ServerApp[]>(`/servers/${id}/apps`), 'Failed to fetch applications');

export interface CaddySnapshotMeta {
  id: string;
  hosts: string[];
  createdAt: string;
}

export const getServerSnapshots = async (id: string): Promise<CaddySnapshotMeta[]> =>
  unwrap(await apiRequest<CaddySnapshotMeta[]>(`/servers/${id}/caddy/snapshots`), 'Failed to fetch snapshots');

export const snapshotServerCaddy = async (id: string): Promise<string> => {
  const res = await apiRequest(`/servers/${id}/caddy/snapshot`, { method: 'POST' });
  if (res.success) return res.message || 'Snapshot taken';
  throw new Error(res.error || 'Failed to snapshot the Caddy config');
};

/** Turn this node's live Caddy routes into application rows. */
export const syncServerApps = async (
  id: string,
): Promise<{ discovered: number; created: number; updated: number; errors?: string[] }> =>
  unwrap(
    await apiRequest(`/servers/${id}/sync-apps`, { method: 'POST' }),
    'Failed to import sites from this server',
  );
