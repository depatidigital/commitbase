import apiRequest from './api';

export interface RdashProfile {
  [key: string]: any;
}

export interface RdashSummary {
  profile: RdashProfile | null;
  domains: any;
  balance: number | string | null;
}

export interface RdashConfigStatus {
  baseUrl: string;
  resellerIdSet: boolean;
  apiKeySet: boolean;
}

export interface CloudflareConfigStatus {
  apiBase: string;
  apiTokenSet: boolean;
  zoneIdSet: boolean;
  dnsTargetSet: boolean;
}

export const getRdashSummary = async (): Promise<RdashSummary> => {
  const response = await apiRequest<RdashSummary>('/rdash/summary', {
    method: 'GET',
  });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to fetch RDASH summary');
};

export const getRdashConfigStatus = async (): Promise<RdashConfigStatus> => {
  const response = await apiRequest<RdashConfigStatus>('/rdash/config', {
    method: 'GET',
  });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to fetch RDASH config');
};

export const getCloudflareConfigStatus = async (): Promise<CloudflareConfigStatus> => {
  const response = await apiRequest<CloudflareConfigStatus>('/cloudflare/config', {
    method: 'GET',
  });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to fetch Cloudflare config');
};

export const getCloudflareZones = async (page?: number, perPage?: number): Promise<any[]> => {
  const params = new URLSearchParams();
  if (page && page > 0) {
    params.append('page', String(page));
  }
  if (perPage && perPage > 0) {
    params.append('perPage', String(perPage));
  }

  const qs = params.toString();
  const endpoint = qs ? `/cloudflare/zones?${qs}` : '/cloudflare/zones';

  const response = await apiRequest<any[]>(endpoint, {
    method: 'GET',
  });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to fetch Cloudflare zones');
};
