import apiRequest, { PaginatedResponse } from './api';

export interface Database {
  id: string;
  name: string;
  type: 'POSTGRESQL' | 'MYSQL' | 'MONGODB' | 'REDIS' | 'SQLITE';
  version?: string;
  config?: Record<string, any>;
  applicationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDatabaseData {
  name: string;
  type: Database['type'];
  version?: string;
  config?: Record<string, any>;
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
  
  throw new Error(response.error || 'Failed to fetch databases');
};

// Get single database
export const getDatabase = async (id: string): Promise<Database> => {
  const response = await apiRequest<Database>(`/databases/${id}`);
  
  if (response.success && response.data) {
    return response.data;
  }
  
  throw new Error(response.error || 'Failed to fetch database');
};

// Create new database
export const createDatabase = async (applicationId: string, data: CreateDatabaseData): Promise<Database> => {
  const response = await apiRequest<Database>('/databases', {
    method: 'POST',
    body: JSON.stringify({ ...data, applicationId }),
  });
  
  if (response.success && response.data) {
    return response.data;
  }
  
  throw new Error(response.error || 'Failed to create database');
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
  
  throw new Error(response.error || 'Failed to update database');
};

// Delete database
export const deleteDatabase = async (id: string): Promise<void> => {
  const response = await apiRequest(`/databases/${id}`, {
    method: 'DELETE',
  });
  
  if (!response.success) {
    throw new Error(response.error || 'Failed to delete database');
  }
}; 