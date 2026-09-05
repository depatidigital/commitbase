import apiRequest, { API_BASE_URL, PaginatedResponse } from './api';

export interface Application {
  id: string;
  name: string;
  domain: string;
  type: 'NODEJS' | 'STATIC' | 'PYTHON' | 'GO' | 'RUST' | 'PHP' | 'JAVA';
  status: 'RUNNING' | 'STOPPED' | 'ERROR' | 'DEPLOYING' | 'BUILDING';
  repository?: string;
  branch?: string;
  buildCommand?: string;
  startCommand?: string;
  port?: number;
  envVars?: Record<string, string>;
  userId: string | null;
  organizationId?: string | null;
  organization?: { id: string; name: string; slug: string } | null;
  createdAt: string;
  updatedAt: string;
  staticSiteUrl?: string | null;
  runtime?: 'PM2' | 'CADDY_PHP' | 'CADDY_STATIC' | 'CADDY_PROXY' | null;
  processName?: string | null;
  rootPath?: string | null;
  configPath?: string | null;
  lastSyncedAt?: string | null;
  deployments?: Deployment[];
  databases?: Database[];
  logs?: Log[];
}

export interface Deployment {
  id: string;
  applicationId: string;
  status: 'PENDING' | 'BUILDING' | 'DEPLOYING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  buildLogs?: string;
  deployedAt?: string;
  createdAt: string;
}

export interface Database {
  id: string;
  name: string;
  type: 'POSTGRESQL' | 'MYSQL' | 'MONGODB' | 'REDIS' | 'SQLITE';
  version?: string;
  config?: Record<string, any>;
  applicationId: string;
  createdAt: string;
}

export interface Log {
  id: string;
  applicationId: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
  message: string;
  timestamp: string;
}

export interface CreateApplicationData {
  name: string;
  domain: string;
  type: Application['type'];
  repository?: string;
  branch?: string;
  buildCommand?: string;
  startCommand?: string;
  port?: number;
  envVars?: Record<string, string>;
}

export interface UpdateApplicationData {
  name?: string;
  domain?: string;
  type?: Application['type'];
  repository?: string;
  branch?: string;
  buildCommand?: string;
  startCommand?: string;
  port?: number;
  envVars?: Record<string, string>;
}

// Get all applications
export const getApplications = async (
  page = 1,
  limit = 10,
  search = ''
): Promise<PaginatedResponse<Application>> => {
  const response = await apiRequest<PaginatedResponse<Application>>(
    `/applications?page=${page}&limit=${limit}${search ? `&search=${encodeURIComponent(search)}` : ''}`
  );
  
  if (response.success && response.data) {
    return response.data;
  }
  
  throw new Error(response.error || 'Failed to fetch applications');
};

// Get single application
export const getApplication = async (id: string): Promise<Application> => {
  const response = await apiRequest<Application>(`/applications/${id}`);
  
  if (response.success && response.data) {
    return response.data;
  }
  
  throw new Error(response.error || 'Failed to fetch application');
};

// Create new application
export const createApplication = async (data: CreateApplicationData): Promise<Application> => {
  const response = await apiRequest<Application>('/applications', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  
  if (response.success && response.data) {
    return response.data;
  }
  
  throw new Error(response.error || 'Failed to create application');
};

export interface DetectedProject {
  type: 'NODEJS' | 'STATIC' | 'PHP' | 'PYTHON';
  framework: string | null;
  label: string;
  packageManager: string;
  installCommand: string;
  buildCommand: string | null;
  startCommand: string | null;
  outputDir: string | null;
  port: number | null;
  nodeVersion: string | null;
}

/** Files the backend reads to recognise a project. Must match DETECT_FILES there. */
export const DETECT_FILES = [
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock',
  '.nvmrc', '.node-version', 'next.config.js', 'next.config.mjs', 'next.config.ts',
  'requirements.txt', 'composer.json', 'index.php', 'index.html',
];

/** Detect from a git URL, or from the files the browser already holds. */
export const detectProject = async (
  input: { repository: string; branch?: string } | { files: Record<string, string> }
): Promise<DetectedProject> => {
  const response = await apiRequest<DetectedProject>('/applications/detect', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (response.success && response.data) return response.data;
  throw new Error(response.error || 'Could not inspect the project');
};

/** Pull the detection files out of a picked folder (root level only). */
export const readDetectFiles = async (files: File[]): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const file of files) {
    const rel = ((file as any).webkitRelativePath as string) || file.name;
    const parts = rel.split('/');
    // folder picks are "<folder>/<name>"; single files are just "<name>"
    const name = parts.length === 2 ? parts[1] : parts.length === 1 ? parts[0] : null;
    if (!name || !DETECT_FILES.includes(name)) continue;
    // lockfiles: presence is all that matters
    out[name] = /lock/.test(name) ? '' : await file.slice(0, 256 * 1024).text();
  }
  return out;
};

/**
 * Ship a picked file or folder as the app's sources. FormData, so it cannot go
 * through apiRequest — that one forces a JSON content type.
 */
export const uploadApplicationSource = async (
  id: string,
  files: File[]
): Promise<{ files: number }> => {
  const body = new FormData();
  files.forEach((file) => {
    body.append('files', file);
    // folder picks carry their path inside the folder; a plain file has none
    body.append('paths', (file as any).webkitRelativePath || file.name);
  });

  const token = localStorage.getItem('authToken');
  const response = await fetch(`${API_BASE_URL}/applications/${id}/source`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body,
  });
  const data = await response.json();

  if (!response.ok || !data.success) {
    throw new Error(data.error || 'Failed to upload source files');
  }

  return data.data;
};

// Update application
export const updateApplication = async (id: string, data: UpdateApplicationData): Promise<Application> => {
  const response = await apiRequest<Application>(`/applications/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  
  if (response.success && response.data) {
    return response.data;
  }
  
  throw new Error(response.error || 'Failed to update application');
};

// Delete application
export const deleteApplication = async (id: string): Promise<void> => {
  const response = await apiRequest(`/applications/${id}`, {
    method: 'DELETE',
  });
  
  if (!response.success) {
    throw new Error(response.error || 'Failed to delete application');
  }
};

// Start existing application (without redeploying)
export const startExistingApplication = async (id: string): Promise<Application | boolean> => {
  const response = await apiRequest<Application>(`/applications/${id}/start-existing`, {
    method: 'POST',
  });
  
  if (response.success) {
    return response.data || true;
  }
  
  throw new Error(response.error || 'Failed to start existing application');
};

// Start application (with redeploy)
export const startApplication = async (id: string): Promise<Application | boolean> => {
  const response = await apiRequest<Application>(`/applications/${id}/start`, {
    method: 'POST',
  });
  
  if (response.success) {
    return response.data || true;
  }
  
  throw new Error(response.error || 'Failed to start application');
};

// Stop application
export const stopApplication = async (id: string): Promise<Application | boolean> => {
  const response = await apiRequest<Application>(`/applications/${id}/stop`, {
    method: 'POST',
  });
  
  if (response.success) {
    return response.data || true;
  }
  
  throw new Error(response.error || 'Failed to stop application');
};

// Restart application
export const restartApplication = async (id: string): Promise<Application | boolean> => {
  const response = await apiRequest<Application>(`/applications/${id}/restart`, {
    method: 'POST',
  });
  
  if (response.success) {
    return response.data || true;
  }
  
  throw new Error(response.error || 'Failed to restart application');
};

// Check if application has been deployed before
export const hasBeenDeployed = (application: Application): boolean => {
  // Check if there are any successful deployments
  if (application.deployments && application.deployments.length > 0) {
    return application.deployments.some(deployment => 
      deployment.status === 'SUCCESS'
    );
  }
  
  // Check if lastDeployment exists (from backend)
  return !!(application as any).lastDeployment;
}; 

export interface AppSyncResult {
  discovered: number;
  created: number;
  updated: number;
  apps: Array<{
    name: string;
    domain: string;
    runtime: 'PM2' | 'CADDY_PHP' | 'CADDY_STATIC' | 'CADDY_PROXY';
    status: 'RUNNING' | 'STOPPED' | 'ERROR';
    port?: number;
    action: 'created' | 'updated';
  }>;
  errors?: string[];
}

// Import/refresh the apps running on the server (pm2 processes + Caddy sites)
export const syncServerApps = async (): Promise<AppSyncResult> => {
  const response = await apiRequest<AppSyncResult>('/applications/sync', { method: 'POST' });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to sync server apps');
};
