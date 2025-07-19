export interface Domain {
  id: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE' | 'PENDING' | 'ERROR';
  dnsRecords?: any;
  sslStatus: 'PENDING' | 'ACTIVE' | 'EXPIRED' | 'ERROR';
  sslExpiry?: string;
  redirectTo?: string;
  customConfig?: any;
  createdAt: string;
  updatedAt: string;
  userId: string;
}

export interface CreateDomainData {
  name: string;
  redirectTo?: string;
  customConfig?: any;
}

export interface UpdateDomainData {
  name?: string;
  status?: 'ACTIVE' | 'INACTIVE' | 'PENDING' | 'ERROR';
  redirectTo?: string;
  customConfig?: any;
}

export interface DomainVerificationResult {
  domain: Domain;
  dnsRecords: any;
  verified: boolean;
}

export interface SSLRenewalResult {
  domain: Domain;
} 