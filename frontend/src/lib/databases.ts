import apiRequest, { PaginatedResponse } from './api';
import { ListParams, listQuery } from './admin';
import type { Paginated } from '@/components/DataTable';
import { t } from './i18n';

export interface Database {
  id: string;
  name: string;
  type: 'POSTGRESQL' | 'MYSQL' | 'MONGODB' | 'REDIS' | 'SQLITE';
  version?: string;
  config?: Record<string, any>;
  applicationId: string | null;
  organizationId?: string | null;
  /** the real name on the server, <org-slug>_<name> */
  dbName?: string | null;
  /** found on the server by the inventory sync rather than created by the panel */
  discovered?: boolean;
  sizeBytes?: number | null;
  /** why the last create or drop failed */
  lastError?: string | null;
  connectionString?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDatabaseData {
  /** the part after the org prefix: lowercase letters, digits, underscores */
  name: string;
  type: 'POSTGRESQL' | 'MYSQL';
  /** owner — or leave it to the app's organization */
  organizationId?: string;
  applicationId?: string;
}

export interface DatabaseCredentials {
  engine: 'POSTGRESQL' | 'MYSQL';
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  tls: boolean;
  url: string;
}

export interface UpdateDatabaseData {
  name?: string;
  type?: Database['type'];
  version?: string;
  config?: Record<string, any>;
}

// Get all databases for an application
export const getDatabases = async (applicationId: string, page = 1, limit = 10): Promise<PaginatedResponse<Database>> => {
  const response = await apiRequest<PaginatedResponse<Database>>(`/databases?applicationId=${applicationId}&page=${page}&limit=${limit}`);
  
  if (response.success && response.data) {
    return response.data;
  }
  
  throw new Error(response.error || t('Failed to fetch databases'));
};

// Get single database
export const getDatabase = async (id: string): Promise<Database> => {
  const response = await apiRequest<Database>(`/databases/${id}`);
  
  if (response.success && response.data) {
    return response.data;
  }
  
  throw new Error(response.error || t('Failed to fetch database'));
};

// Create a database on the organization's database server
export const createDatabase = async (data: CreateDatabaseData): Promise<Database> => {
  const response = await apiRequest<Database>('/databases', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  
  if (response.success && response.data) {
    return response.data;
  }
  
  throw new Error(response.error || t('Failed to create database'));
};

// Update database
export const updateDatabase = async (id: string, data: UpdateDatabaseData): Promise<Database> => {
  const response = await apiRequest<Database>(`/databases/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  
  if (response.success && response.data) {
    return response.data;
  }
  
  throw new Error(response.error || t('Failed to update database'));
};

/** Retry a create that failed on the server. */
export const provisionDatabase = async (id: string): Promise<Database> => {
  const response = await apiRequest<Database>(`/databases/${id}/provision`, { method: 'POST' });
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Failed to create database'));
};

/** The password — every read is written to the audit log. */
export const getDatabaseCredentials = async (id: string): Promise<DatabaseCredentials> => {
  const response = await apiRequest<DatabaseCredentials>(`/databases/${id}/credentials`);
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Failed to fetch the credentials'));
};

// Delete database. A database the panel created is dropped on its server, so
// the caller types its name to confirm.
export const deleteDatabase = async (id: string, confirm?: string): Promise<void> => {
  const response = await apiRequest(`/databases/${id}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirm }),
  });
  
  if (!response.success) {
    throw new Error(response.error || t('Failed to delete database'));
  }
}; 
export interface DatabaseWithApplication extends Database {
  status: 'CREATING' | 'RUNNING' | 'STOPPED' | 'ERROR';
  port?: number | null;
  memory?: string | null;
  cpu?: string | null;
  /** null for a database found on a server that no app uses yet */
  application: {
    id: string;
    name: string;
    domain: string;
    organization?: { id: string; name: string; slug: string } | null;
  } | null;
  /** the org that owns the database itself — falls back to the app's for older rows */
  organization?: { id: string; name: string; slug: string } | null;
  databaseServer?: { id: string; name: string; engine: string } | null;
}

/** Connect a database to an app: its URL is written into the app's env under `envKey`, server-side. */
export const attachDatabase = async (
  databaseId: string,
  applicationId: string,
  envKey = 'DATABASE_URL',
  /** the app's other database variables (DB_HOST, DIRECT_URL…) to fill from the same credentials */
  alsoKeys: string[] = []
): Promise<{ envKey: string; keys: string[]; database: string }> => {
  const response = await apiRequest<{ envKey: string; keys: string[]; database: string }>(`/databases/${databaseId}/attach`, {
    method: 'POST',
    body: JSON.stringify({ applicationId, envKey, alsoKeys }),
  });
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Failed to connect the database'));
};

// Every database across the organizations the caller belongs to
export const getAllDatabases = async (
  params: ListParams
): Promise<Paginated<DatabaseWithApplication>> => {
  const response = await apiRequest<Paginated<DatabaseWithApplication>>(
    `/databases${listQuery(params)}`
  );

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t('Failed to fetch databases'));
};
