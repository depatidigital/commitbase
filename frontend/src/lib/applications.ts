import apiRequest, { PaginatedResponse } from './api';

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
