import apiRequest from './api';
import { ListParams, listQuery } from './admin';
import type { Paginated } from '@/components/DataTable';
import { Domain, CreateDomainData, UpdateDomainData, DomainVerificationResult } from '@/types/domain';

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

export type DomainSyncResult = {
  total: number;
  created: number;
  updated: number;
  cfOnly: number;
  rdashOnly: number;
  errors?: Record<string, string>;
};

// Reconcile domains from RDASH (registrar) and Cloudflare (DNS) into our list
export const syncDomains = async (): Promise<DomainSyncResult> => {
  const response = await apiRequest<DomainSyncResult>('/domains/sync', { method: 'POST' });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to sync domains');
};

export const bulkAssignDomains = async (
  ids: string[],
  organizationId: string | null
): Promise<number> => {
  const response = await apiRequest<{ count: number }>('/domains/bulk-assign', {
    method: 'PATCH',
    body: JSON.stringify({ ids, organizationId }),
  });

  if (response.success && response.data) {
    return response.data.count;
  }

  throw new Error(response.error || 'Failed to assign domains');
};

export type RdashDns = {
  registered: boolean;
  nameservers: string[];
  delegatedToCloudflare?: boolean;
  records: any[];
};

// What the registrar still holds for the domain, before/independently of Cloudflare
export const getRdashDns = async (id: string): Promise<RdashDns> => {
  const response = await apiRequest<RdashDns>(`/domains/${id}/rdash-dns`);

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to read DNS from RDASH');
};

export type CloudflareEnableResult = {
  steps: string[];
  warnings: string[];
  nameserversUpdated: boolean;
  recordsImported: number;
  zone: { id: string; name: string; nameServers: string[] };
};

export const enableCloudflare = async (id: string): Promise<CloudflareEnableResult> => {
  const response = await apiRequest<CloudflareEnableResult>(`/domains/${id}/cloudflare/enable`, {
    method: 'POST',
  });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to enable Cloudflare');
};

export const disableCloudflare = async (id: string): Promise<void> => {
  const response = await apiRequest(`/domains/${id}/cloudflare/disable`, { method: 'POST' });

  if (!response.success) {
    throw new Error(response.error || 'Failed to disable Cloudflare');
  }
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
