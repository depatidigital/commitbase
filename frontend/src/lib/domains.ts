import apiRequest from './api';
import { Domain, CreateDomainData, UpdateDomainData, DomainVerificationResult, SSLRenewalResult } from '@/types/domain';

// Get all domains
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