import apiRequest from './api';
import { ListParams, listQuery } from './admin';
import type { Paginated } from '@/components/DataTable';
import { Domain, CreateDomainData, UpdateDomainData, DomainVerificationResult, SSLRenewalResult } from '@/types/domain';

// Get all domains
export const getDomainsPage = async (params: ListParams): Promise<Paginated<Domain>> => {
  const response = await apiRequest<Paginated<Domain>>(`/domains${listQuery(params)}`);

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to fetch domains');
};

export const getDomains = async (): Promise<Domain[]> => {
  const response = await apiRequest<Domain[]>('/domains', {
    method: 'GET',
  });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to fetch domains');
};

// Get a specific domain
export const getDomain = async (id: string): Promise<Domain> => {
  const response = await apiRequest<Domain>(`/domains/${id}`, {
    method: 'GET',
  });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to fetch domain');
};

export type DomainDnsZone = {
  zone: {
    id: string;
    name: string;
    nameservers: string[];
  } | null;
  records: any[];
  synced: boolean;
};

export const getDomainDnsZone = async (id: string): Promise<DomainDnsZone> => {
  const response = await apiRequest<DomainDnsZone>(`/domains/${id}/dns-zone`, {
    method: 'GET',
  });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to fetch domain DNS zone');
};

// Create a new domain
export const createDomain = async (data: CreateDomainData): Promise<Domain> => {
  const response = await apiRequest<Domain>('/domains', {
    method: 'POST',
    body: JSON.stringify(data),
  });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to create domain');
};

// Import all Cloudflare zones as domains (organization left empty)
export type CloudflareSyncResult = { total: number; created: number; updated: number };

export const syncCloudflareDomains = async (): Promise<CloudflareSyncResult> => {
  const response = await apiRequest<CloudflareSyncResult>('/domains/sync-cloudflare', {
    method: 'POST',
  });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to sync Cloudflare domains');
};

// Update a domain
export const updateDomain = async (id: string, data: UpdateDomainData): Promise<Domain> => {
  const response = await apiRequest<Domain>(`/domains/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to update domain');
};

// Delete a domain
export const deleteDomain = async (id: string): Promise<void> => {
  const response = await apiRequest(`/domains/${id}`, {
    method: 'DELETE',
  });

  if (!response.success) {
    throw new Error(response.error || 'Failed to delete domain');
  }
};

// Verify domain DNS
export const verifyDomain = async (id: string): Promise<DomainVerificationResult> => {
  const response = await apiRequest<DomainVerificationResult>(`/domains/${id}/verify`, {
    method: 'POST',
  });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to verify domain');
};

// Renew SSL certificate
export const renewSSL = async (id: string): Promise<SSLRenewalResult> => {
  const response = await apiRequest<SSLRenewalResult>(`/domains/${id}/ssl/renew`, {
    method: 'POST',
  });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to renew SSL certificate');
}; 
