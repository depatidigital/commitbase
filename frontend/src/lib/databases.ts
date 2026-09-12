import apiRequest, { API_BASE_URL, PaginatedResponse } from './api';
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
  databaseServerId?: string | null;
  /** found on the server by the inventory sync rather than created by the panel */
  discovered?: boolean;
  sizeBytes?: number | null;
  /** why the last create or drop failed */
  lastError?: string | null;
  connectionString?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Which login reaches a database: one the org has, a new one (the part after the org prefix), or its default. */
export type LoginChoice = { accountId: string } | { username: string };

export interface CreateDatabaseData {
  /** the part after the org prefix: lowercase letters, digits, underscores */
  name: string;
  /** the engine; taken from the server when one is chosen */
  type?: 'POSTGRESQL' | 'MYSQL';
  /** the server to create it on — else the organization's server for the engine */
  databaseServerId?: string;
  login?: LoginChoice;
  /** owner — or leave it to the app's organization */
  organizationId?: string;
  applicationId?: string;
}

/** A server a database can be created on: online, name and engine only. */
export interface DatabaseServerChoice {
  id: string;
  name: string;
  engine: 'POSTGRESQL' | 'MYSQL';
  version: string | null;
  /** the organization's own server for this engine */
  default: boolean;
}

/** One of an organization's logins on a server, and the databases it reaches. */
export interface DatabaseLogin {
  id: string;
  username: string;
  databases: Array<{ id: string; dbName: string | null }>;
}

export const getDatabaseServerChoices = async (organizationId?: string | null): Promise<DatabaseServerChoice[]> => {
  const response = await apiRequest<DatabaseServerChoice[]>(
    `/databases/servers${organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : ''}`,
  );
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Failed to load database servers'));
};

/** `prefix`: what a new login's name starts with — the org's slug. */
export const getDatabaseLogins = async (
  organizationId: string,
  databaseServerId: string,
): Promise<{ prefix: string; logins: DatabaseLogin[] }> => {
  const response = await apiRequest<{ prefix: string; logins: DatabaseLogin[] }>(
    `/databases/logins?organizationId=${encodeURIComponent(organizationId)}&databaseServerId=${encodeURIComponent(databaseServerId)}`,
  );
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Failed to load database logins'));
};

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
/**
 * Try a database URL from the app's own node with the URL's credentials — the
 * value being edited, else the saved variable `key`. Resolves either way.
 */
export const testDatabaseUrl = async (
  applicationId: string,
  key: string,
  value?: string,
): Promise<{ ok: boolean; message: string }> => {
  const response = await apiRequest<{ ok: boolean; message: string }>('/databases/test-url', {
    method: 'POST',
    body: JSON.stringify({ applicationId, key, value }),
  });
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Could not test the connection'));
};

/** `accountId`: the login it was made with, for the attach that follows. */
export const createDatabase = async (data: CreateDatabaseData): Promise<Database & { accountId?: string }> => {
  const response = await apiRequest<Database & { accountId?: string }>('/databases', {
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
  alsoKeys: string[] = [],
  /** the login the app connects as — given access first if it has none; else the database's own */
  login?: LoginChoice
): Promise<{ envKey: string; keys: string[]; database: string }> => {
  const response = await apiRequest<{ envKey: string; keys: string[]; database: string }>(`/databases/${databaseId}/attach`, {
    method: 'POST',
    body: JSON.stringify({ applicationId, envKey, alsoKeys, login }),
  });
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Failed to connect the database'));
};

/** A database an app uses: linked to it, or named by its env (`inUse`) — the one its code talks to. */
export interface AppDatabase extends Database {
  status: DatabaseWithApplication['status'];
  inUse: boolean;
  databaseServer?: { id: string; name: string; engine: string } | null;
}

export const getAppDatabases = async (applicationId: string): Promise<AppDatabase[]> => {
  const response = await apiRequest<AppDatabase[]>(`/databases/application/${applicationId}`);
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Failed to fetch databases'));
};

/** One run of an uploaded .sql file, with its live log while it runs. */
export interface DatabaseImport {
  id: string;
  databaseId: string;
  fileName: string;
  sizeBytes: number;
  sha256: string | null;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  statements: number;
  skipped: number;
  log: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  user?: { id: string; name: string | null; email: string } | null;
}

export const getDatabaseTables = async (id: string): Promise<number> => {
  const response = await apiRequest<{ tables: number }>(`/databases/${id}/tables`);
  if (response.success && response.data) return response.data.tables;
  throw new Error(response.error || t('Could not reach the database'));
};

export const getDatabaseImports = async (id: string): Promise<DatabaseImport[]> => {
  const response = await apiRequest<DatabaseImport[]>(`/databases/${id}/imports`);
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Failed to load imports'));
};

/**
 * Upload a .sql / .sql.gz to run in the database. Resolves once the server has
 * the file and the run has started. XHR for upload progress, like the source upload.
 */
export const importDatabase = async (
  id: string,
  file: File,
  options: { confirm?: string; onProgress?: (fraction: number) => void } = {},
): Promise<DatabaseImport> => {
  const body = new FormData();
  body.append('file', file);
  const query = options.confirm ? `?confirm=${encodeURIComponent(options.confirm)}` : '';
  const token = localStorage.getItem('authToken');
  const fallback = t('Failed to upload the file');

  const data = await new Promise<{ success?: boolean; error?: string; data?: DatabaseImport }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE_URL}/databases/${id}/import${query}`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && options.onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      try {
        const parsed = JSON.parse(xhr.responseText);
        resolve(xhr.status >= 200 && xhr.status < 300 ? parsed : { ...parsed, success: false });
      } catch {
        reject(new Error(xhr.status === 413 ? t('The file is too large') : fallback));
      }
    };
    xhr.onerror = () => reject(new Error(fallback));
    xhr.send(body);
  });

  if (!data.success || !data.data) throw new Error(data.error || fallback);
  return data.data;
};

/**
 * Download a backup (.sql.gz) of the database. Fetched with the auth header, so
 * it arrives as a blob and is saved from there.
 * ponytail: the whole file sits in memory before the save — a signed one-time
 * URL the browser downloads directly, if databases outgrow that.
 */
export const downloadDatabaseBackup = async (id: string): Promise<void> => {
  const token = localStorage.getItem('authToken');
  const response = await fetch(`${API_BASE_URL}/databases/${id}/backup`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || t('Backup failed'));
  }
  const blob = await response.blob().catch(() => {
    throw new Error(t('Backup failed'));
  });
  const name = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? 'backup.sql.gz';
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

/**
 * What a dump's first 64 KB say, before anything is uploaded: the engine it
 * was made for, and whether it names another database. The server checks the
 * whole file again — this only saves a pointless upload.
 */
export const sniffDump = async (file: File): Promise<{ engine: 'POSTGRESQL' | 'MYSQL' | null; otherDatabase: string | null }> => {
  const LIMIT = 64 * 1024;
  let head = '';
  try {
    const magic = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    if (magic[0] === 0x1f && magic[1] === 0x8b) {
      const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream()).getReader();
      while (head.length < LIMIT) {
        const { done, value } = await reader.read();
        if (done) break;
        head += value;
      }
      reader.cancel().catch(() => {});
    } else {
      head = await file.slice(0, LIMIT).text();
    }
  } catch {
    return { engine: null, otherDatabase: null };
  }

  const engine = /PostgreSQL database dump|^\\restrict\s|pg_catalog\./m.test(head)
    ? 'POSTGRESQL'
    : /(MySQL|MariaDB) dump|^\/\*!\d{5}/im.test(head)
      ? 'MYSQL'
      : null;
  const named =
    /^\\c(?:onnect)?\s+(?:-reuse-previous=\S+\s+)?"?([^\s"]+)/m.exec(head)?.[1] ??
    /^USE\s+`?([^`;\s]+)`?\s*;/im.exec(head)?.[1] ??
    null;
  return { engine, otherDatabase: named };
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
