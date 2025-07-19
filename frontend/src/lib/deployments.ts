import apiRequest, { PaginatedResponse } from './api';

export interface Deployment {
  id: string;
  applicationId: string;
  status: 'PENDING' | 'BUILDING' | 'DEPLOYING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  buildLogs?: string;
  deployLogs?: string;
  commitHash?: string;
  commitMessage?: string;
  buildTime?: number;
  buildSize?: string;
  envVars?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  application?: {
    id: string;
    name: string;
    domain: string;
  };
}

export interface CreateDeploymentData {
  status?: string;
  buildLogs?: string;
  deployLogs?: string;
}

export interface UpdateDeploymentData {
  status?: string;
  buildLogs?: string;
  deployLogs?: string;
}

// Get deployment history for an application
export const getDeploymentHistory = async (appId: string, page = 1, limit = 10): Promise<PaginatedResponse<Deployment>> => {
  const response = await apiRequest<{ deployments: Deployment[]; pagination: any }>(`/deployments/application/${appId}?page=${page}&limit=${limit}`);
  
  if (response.success && response.data) {
    return {
      data: response.data.deployments,
      pagination: response.data.pagination,
    };
  }
  
  throw new Error(response.error || 'Failed to fetch deployment history');
};

// Get specific deployment by ID
export const getDeployment = async (deploymentId: string): Promise<Deployment> => {
  const response = await apiRequest<Deployment>(`/deployments/${deploymentId}`);
  
  if (response.success && response.data) {
    return response.data;
  }
  
  throw new Error(response.error || 'Failed to fetch deployment');
};

// Get deployment logs
export const getDeploymentLogs = async (deploymentId: string, logType = 'build', lines = 100): Promise<{ logs: string; deploymentId: string; logType: string; lines: number }> => {
  const response = await apiRequest<{ logs: string; deploymentId: string; logType: string; lines: number }>(`/deployments/${deploymentId}/logs?type=${logType}&lines=${lines}`);
  
  if (response.success && response.data) {
    return response.data;
  }
  
  throw new Error(response.error || 'Failed to fetch deployment logs');
};

// Create a new deployment
export const createDeployment = async (appId: string, data: CreateDeploymentData): Promise<Deployment> => {
  const response = await apiRequest<Deployment>(`/deployments/application/${appId}`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
  
  if (response.success && response.data) {
    return response.data;
  }
  
  throw new Error(response.error || 'Failed to create deployment');
};

// Update deployment
export const updateDeployment = async (deploymentId: string, data: UpdateDeploymentData): Promise<Deployment> => {
  const response = await apiRequest<Deployment>(`/deployments/${deploymentId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  
  if (response.success && response.data) {
    return response.data;
  }
  
  throw new Error(response.error || 'Failed to update deployment');
};

// Delete deployment
export const deleteDeployment = async (deploymentId: string): Promise<void> => {
  const response = await apiRequest(`/deployments/${deploymentId}`, {
    method: 'DELETE',
  });
  
  if (!response.success) {
    throw new Error(response.error || 'Failed to delete deployment');
  }
}; 