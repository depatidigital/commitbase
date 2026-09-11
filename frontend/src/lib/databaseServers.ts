import apiRequest from './api';
import { ListParams, listQuery } from './admin';
import type { Paginated } from '@/components/DataTable';
import type { Organization } from './organizations';
import { t } from '@/lib/i18n';

export type DbEngine = 'POSTGRESQL' | 'MYSQL';
/** TUNNEL: on one of our nodes, reached through its SSH connection. DIRECT: a managed service over TLS. */
export type DbServerMode = 'TUNNEL' | 'DIRECT';
export type DbTlsMode = 'DISABLE' | 'REQUIRE' | 'VERIFY';

export interface DatabaseServer {
  id: string;
  name: string;
  engine: DbEngine;
  mode: DbServerMode;
  serverId: string | null;
  server: { id: string; name: string; hostname: string } | null;
  host: string;
  port: number;
  tlsMode: DbTlsMode;
  caCert: string | null;
  adminUser: string;
  /** The password itself never leaves the backend — only whether one is stored. */
  hasPassword: boolean;
  appHost: string;
  status: 'ONLINE' | 'OFFLINE' | 'UNKNOWN';
  version: string | null;
  /** comma-separated, from the last check: "CREATEROLE,CREATEDB" or with "superuser" */
  adminRights: string | null;
  lastSeenAt: string | null;
  lastError: string | null;
  createdAt: string;
  _count: { databases: number; postgresOrgs: number; mysqlOrgs: number };
}

export type DatabaseServerInput = {
  name: string;
  engine: DbEngine;
  mode: DbServerMode;
  serverId?: string | null;
  host: string;
  port: number;
  tlsMode: DbTlsMode;
  caCert?: string | null;
  adminUser: string;
  /** Sent only when set; an empty value on edit keeps the stored one. */
  adminPassword?: string;
  appHost: string;
};

export const ENGINE_LABEL: Record<DbEngine, string> = { POSTGRESQL: 'PostgreSQL', MYSQL: 'MySQL' };
export const DEFAULT_PORT: Record<DbEngine, number> = { POSTGRESQL: 5432, MYSQL: 3306 };

const unwrap = <T>(res: { success: boolean; data?: T; error?: string }, fallback: string): T => {
  if (res.success) return res.data as T;
  throw new Error(res.error || fallback);
};

/** Unpaged, for the placement pickers — optionally one engine. */
export const getDatabaseServers = async (engine?: DbEngine): Promise<DatabaseServer[]> =>
  unwrap(
    await apiRequest<DatabaseServer[]>(`/database-servers${engine ? `?engine=${engine}` : ''}`),
    t('Failed to fetch database servers'),
  );

export const getDatabaseServersPage = async (params: ListParams): Promise<Paginated<DatabaseServer>> =>
  unwrap(
    await apiRequest<Paginated<DatabaseServer>>(`/database-servers${listQuery(params)}`),
    t('Failed to fetch database servers'),
  );

/** Create and update answer with a message saying whether the server could be reached. */
export const createDatabaseServer = async (data: DatabaseServerInput) => {
  const res = await apiRequest<DatabaseServer>('/database-servers', { method: 'POST', body: JSON.stringify(data) });
  return { server: unwrap(res, t('Failed to register the database server')), message: res.message };
};

export const updateDatabaseServer = async (id: string, data: Partial<DatabaseServerInput>) => {
  const res = await apiRequest<DatabaseServer>(`/database-servers/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  return { server: unwrap(res, t('Failed to update the database server')), message: res.message };
};

export const deleteDatabaseServer = async (id: string) =>
  unwrap(await apiRequest(`/database-servers/${id}`, { method: 'DELETE' }), t('Failed to remove the database server'));

/** Connection test. Resolves either way — `ok` says whether it answered. */
export const testDatabaseServer = async (id: string) => {
  const res = await apiRequest<DatabaseServer>(`/database-servers/${id}/test`, { method: 'POST' });
  return { ok: res.success, message: res.success ? res.message : res.error };
};

export const getDatabaseServer = async (id: string): Promise<DatabaseServer> =>
  unwrap(await apiRequest<DatabaseServer>(`/database-servers/${id}`), t('Failed to fetch database servers'));

/** A database on the server — found by the sync, or created by us. */
export interface ServerDatabase {
  id: string;
  name: string;
  dbName: string | null;
  status: 'CREATING' | 'RUNNING' | 'STOPPED' | 'ERROR';
  discovered: boolean;
  sizeBytes: number | null;
  organization: { id: string; name: string } | null;
  application: { id: string; name: string } | null;
}

/** A login on the server, mirrored by the sync. */
export interface DatabaseLogin {
  id: string;
  username: string;
  /** MySQL account host; empty for Postgres */
  host: string;
  canLogin: boolean;
  superuser: boolean;
  databases: string[];
  lastSeenAt: string;
}

export const getDatabaseServerInventory = async (
  id: string,
): Promise<{ databases: ServerDatabase[]; users: DatabaseLogin[] }> =>
  unwrap(
    await apiRequest<{ databases: ServerDatabase[]; users: DatabaseLogin[] }>(`/database-servers/${id}/inventory`),
    t('Failed to fetch the inventory'),
  );

/** Re-read the server's databases and logins. Resolves with the summary line. */
export const syncDatabaseServer = async (id: string): Promise<string | undefined> => {
  const res = await apiRequest(`/database-servers/${id}/sync`, { method: 'POST' });
  unwrap(res, t('Sync failed'));
  return res.message;
};

export const assignServerDatabase = async (serverId: string, databaseId: string, organizationId: string | null) =>
  unwrap(
    await apiRequest(`/database-servers/${serverId}/databases/${databaseId}/organization`, {
      method: 'PUT',
      body: JSON.stringify({ organizationId }),
    }),
    t('Assign failed'),
  );

/** Place an organization on a database server for one engine; null unplaces. */
export const setOrganizationDatabaseServer = async (
  organizationId: string,
  engine: DbEngine,
  databaseServerId: string | null,
): Promise<Organization> =>
  unwrap(
    await apiRequest<Organization>(`/organizations/${organizationId}/database-server`, {
      method: 'PUT',
      body: JSON.stringify({ engine, databaseServerId }),
    }),
    t('Failed to place the organization'),
  );
