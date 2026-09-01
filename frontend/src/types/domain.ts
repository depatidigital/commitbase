export interface OrganizationRef {
  id: string;
  name: string;
  slug: string;
}

export interface Domain {
  organization?: OrganizationRef | null;
  id: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE' | 'PENDING' | 'ERROR';
  dnsRecords?: any;
  sslStatus: 'PENDING' | 'ACTIVE' | 'EXPIRED' | 'ERROR';
  sslExpiry?: string;
  redirectTo?: string;
  customConfig?: any;
  registrar?: 'RDASH' | 'EXTERNAL' | null;
  cfZoneId?: string | null;
  expiresAt?: string | null;
  lastSyncedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  userId: string;
}

export interface CreateDomainData {
  name: string;
  organizationId: string;
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