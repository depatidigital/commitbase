import apiRequest, { API_BASE_URL, PaginatedResponse } from './api';
import { t } from './i18n';

export interface Log {
  id: string;
  applicationId: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
  message: string;
  timestamp: string;
  metadata?: Record<string, any>;
}

export interface LogFilters {
  level?: Log['level'];
  startDate?: string;
  endDate?: string;
  search?: string;
}

// Get logs for an application
export const getLogs = async (
  applicationId: string, 
  page = 1, 
  limit = 50, 
  filters?: LogFilters
): Promise<PaginatedResponse<Log>> => {
  const params = new URLSearchParams({
    applicationId,
    page: page.toString(),
    limit: limit.toString(),
    ...(filters?.level && { level: filters.level }),
    ...(filters?.startDate && { startDate: filters.startDate }),
    ...(filters?.endDate && { endDate: filters.endDate }),
    ...(filters?.search && { search: filters.search }),
  });

  const response = await apiRequest<PaginatedResponse<Log>>(`/logs?${params.toString()}`);
  
  if (response.success && response.data) {
    return response.data;
  }
  
  throw new Error(response.error || t('Failed to fetch logs'));
};

// Clear logs for an application
export const clearLogs = async (applicationId: string): Promise<void> => {
  const response = await apiRequest(`/logs/${applicationId}/clear`, {
    method: 'DELETE',
  });
  
  if (!response.success) {
    throw new Error(response.error || t('Failed to clear logs'));
  }
};

// Export logs
export const exportLogs = async (
  applicationId: string, 
  format: 'json' | 'csv' = 'json',
  filters?: LogFilters
): Promise<Blob> => {
  const params = new URLSearchParams({
    applicationId,
    format,
    ...(filters?.level && { level: filters.level }),
    ...(filters?.startDate && { startDate: filters.startDate }),
    ...(filters?.endDate && { endDate: filters.endDate }),
    ...(filters?.search && { search: filters.search }),
  });

  const token = localStorage.getItem('authToken');
  const response = await fetch(`${API_BASE_URL}/logs/export?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(t('Failed to export logs'));
  }

  return response.blob();
}; 
export interface SystemLog extends Log {
  application: { id: string; name: string } | null;
}

// Recent log lines the caller may see: their own, plus their organizations' apps
export const getSystemLogs = async (
  lines = 200,
  level: 'all' | 'error' | 'warn' | 'info' = 'all'
): Promise<SystemLog[]> => {
  const response = await apiRequest<SystemLog[]>(`/logs/system?lines=${lines}&type=${level}`);

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t('Failed to fetch logs'));
};
