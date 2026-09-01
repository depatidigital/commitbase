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
  /** what "this platform" resolves to, so records pointing at us can be labelled */
  platformTarget: { type: 'A' | 'CNAME'; content: string } | null;
  /** record ids kept out of the subdomain list; they still exist in Cloudflare */
  hiddenDnsRecords: string[];
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
export type DomainSyncState = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  result: DomainSyncResult | null;
  error: string | null;
};

// Starts the run and returns straight away — a sync takes minutes.
export const startDomainSync = async (): Promise<DomainSyncState> => {
  const response = await apiRequest<DomainSyncState>('/domains/sync', { method: 'POST' });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to start the domain sync');
};

export const getDomainSyncStatus = async (): Promise<DomainSyncState> => {
  const response = await apiRequest<DomainSyncState>('/domains/sync/status');

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to read the sync status');
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

export type DnsRecordInput = {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
  proxied?: boolean;
};

export const createDnsRecord = async (domainId: string, record: DnsRecordInput): Promise<any> => {
  const response = await apiRequest<any>(`/domains/${domainId}/dns-records`, {
    method: 'POST',
    body: JSON.stringify(record),
  });

  if (response.success) return response.data;
  throw new Error(response.error || 'Failed to create the DNS record');
};

export const updateDnsRecord = async (
  domainId: string,
  recordId: string,
  record: DnsRecordInput
): Promise<any> => {
  const response = await apiRequest<any>(`/domains/${domainId}/dns-records/${recordId}`, {
    method: 'PUT',
    body: JSON.stringify(record),
  });

  if (response.success) return response.data;
  throw new Error(response.error || 'Failed to update the DNS record');
};

export const deleteDnsRecord = async (domainId: string, recordId: string): Promise<void> => {
  const response = await apiRequest(`/domains/${domainId}/dns-records/${recordId}`, {
    method: 'DELETE',
  });

  if (!response.success) {
    throw new Error(response.error || 'Failed to delete the DNS record');
  }
};

export const importRegistrarDns = async (
  domainId: string
): Promise<{ imported: number; skipped: number; failed: string[] }> => {
  const response = await apiRequest<{ imported: number; skipped: number; failed: string[] }>(
    `/domains/${domainId}/dns-records/import`,
    { method: 'POST' }
  );

  if (response.success && response.data) return response.data;
  throw new Error(response.error || 'Failed to import the registrar DNS records');
};

export const hideDnsRecord = async (
  domainId: string,
  recordId: string,
  hidden = true
): Promise<void> => {
  const response = await apiRequest(`/domains/${domainId}/dns-records/${recordId}/hide`, {
    method: 'POST',
    body: JSON.stringify({ hidden }),
  });

  if (!response.success) {
    throw new Error(response.error || 'Failed to update the subdomain list');
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

// Renew a domain registration at the registrar (RDASH only)
export const renewDomain = async (id: string, years = 1): Promise<string> => {
  const response = await apiRequest(`/domains/${id}/renew`, {
    method: 'POST',
    body: JSON.stringify({ years }),
  });

  if (!response.success) {
    throw new Error(response.error || 'Failed to renew domain');
  }

  return response.message || 'Renewal submitted.';
};

export type DomainRegistration = {
  domain: string;
  registrar: string | null;
  registrarId: string | null;
  status: string[];
  registeredAt: string | null;
  updatedAt: string | null;
  expiresAt: string | null;
  nameservers: string[];
};

// Registry record (RDAP). null means the TLD publishes nothing we can read.
export const getDomainRegistration = async (
  id: string
): Promise<DomainRegistration | null> => {
  const response = await apiRequest<DomainRegistration | null>(
    `/domains/${id}/registration`
  );

  if (!response.success) {
    throw new Error(response.error || 'Failed to look up the registration');
  }

  return response.data ?? null;
};
