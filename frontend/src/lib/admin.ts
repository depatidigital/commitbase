import type { OrgNode } from './organizations';
import apiRequest from './api';
import { t } from './i18n';
import type { Paginated } from '@/components/DataTable';

export interface ListParams {
  page: number;
  limit: number;
  search: string;
  organizationId?: string;
  /** endpoint-specific narrowing, e.g. domains ?filter=unassigned */
  filter?: string;
  status?: string;
  sort?: string;
  order?: string;
  /** domains only: 'expired' or a day window like '30' */
  expiring?: string;
  /** applications only */
  type?: string;
  serverId?: string;
}

export const listQuery = ({
  page,
  limit,
  search,
  organizationId,
  filter,
  status,
  expiring,
  sort,
  order,
  type,
  serverId,
}: ListParams) =>
  `?page=${page}&limit=${limit}` +
  (type ? `&type=${encodeURIComponent(type)}` : '') +
  (serverId ? `&serverId=${encodeURIComponent(serverId)}` : '') +
  (search ? `&search=${encodeURIComponent(search)}` : '') +
  (organizationId ? `&organizationId=${encodeURIComponent(organizationId)}` : '') +
  (filter ? `&filter=${encodeURIComponent(filter)}` : '') +
  (status ? `&status=${encodeURIComponent(status)}` : '') +
  (expiring ? `&expiring=${encodeURIComponent(expiring)}` : '') +
  (sort ? `&sort=${encodeURIComponent(sort)}&order=${order === 'desc' ? 'desc' : 'asc'}` : '');

export type OrgRole = 'OWNER' | 'ADMIN' | 'MEMBER';

/** Display labels — the enum values themselves go to the API untouched. */
export const ORG_ROLE_LABEL: Record<OrgRole, string> = {
  OWNER: t('Owner'),
  ADMIN: t('Admin'),
  MEMBER: t('Member'),
};

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: 'ADMIN' | 'USER' | 'CLIENT';
  isActive: boolean;
  createdAt: string;
  memberships: { role: OrgRole; organization: OrgSummary }[];
}

export const PLATFORM_ROLE_LABEL: Record<AdminUser['role'], string> = {
  ADMIN: t('Admin'),
  USER: t('User'),
  CLIENT: t('Client'),
};

export interface AdminDomain {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  organization: OrgSummary | null;
  user: { id: string; email: string; name: string | null; role: string } | null;
  _count: { applications: number };
}

export interface CreateUserData {
  email: string;
  name?: string;
  password: string;
  role?: AdminUser['role'];
}

const unwrap = <T>(res: { success: boolean; data?: T; error?: string }, fallback: string): T => {
  // DELETE routes answer { success: true } with no body — that is still a success
  if (res.success) return res.data as T;
  throw new Error(res.error || fallback);
};

export const getUsers = async (params: ListParams): Promise<Paginated<AdminUser>> =>
  unwrap(
    await apiRequest<Paginated<AdminUser>>(`/admin/users${listQuery(params)}`),
    t('Failed to fetch users')
  );

export const createUser = async (data: CreateUserData): Promise<AdminUser> =>
  unwrap(
    await apiRequest<AdminUser>('/admin/users', { method: 'POST', body: JSON.stringify(data) }),
    t('Failed to create user')
  );

export const updateUser = async (
  id: string,
  data: { isActive?: boolean; role?: AdminUser['role']; name?: string }
): Promise<AdminUser> =>
  unwrap(
    await apiRequest<AdminUser>(`/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    t('Failed to update user')
  );

export const getAdminDomains = async (params: ListParams): Promise<Paginated<AdminDomain>> =>
  unwrap(
    await apiRequest<Paginated<AdminDomain>>(`/admin/domains${listQuery(params)}`),
    t('Failed to fetch domains')
  );

export const assignDomain = async (domainId: string, organizationId: string) =>
  unwrap(
    await apiRequest(`/admin/domains/${domainId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ organizationId }),
    }),
    t('Failed to assign domain')
  );

export const unassignDomain = async (domainId: string) =>
  unwrap(
    await apiRequest(`/admin/domains/${domainId}/assign`, { method: 'DELETE' }),
    t('Failed to unassign domain')
  );


// --- Organization OS provisioning -------------------------------------------

export interface AdminOrganization extends OrgSummary {
  createdAt: string;
  _count: { members: number; domains: number; applications: number };
  /** Where new apps of this org go unless one is picked. */
  defaultServer: { id: string; name: string; status: string } | null;
  /** The nodes the org is provisioned on — one per node its apps use. */
  nodes: OrgNode[];
}

export interface ProvisionLog {
  id: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
  message: string;
  timestamp: string;
  metadata: Record<string, unknown> | null;
  user: { id: string; email: string; name: string | null } | null;
}

export const getAdminOrganizations = async (
  params: ListParams
): Promise<Paginated<AdminOrganization>> =>
  unwrap(
    await apiRequest<Paginated<AdminOrganization>>(`/admin/organizations${listQuery(params)}`),
    t('Failed to fetch organizations')
  );

export const provisionOrganization = async (
  organizationId: string,
  limits?: { diskQuota?: string; cpuQuota?: string; memoryMax?: string }
) =>
  unwrap(
    await apiRequest(`/admin/organizations/${organizationId}/provision`, {
      method: 'POST',
      body: JSON.stringify(limits ?? {}),
    }),
    t('Failed to provision organization')
  );

export const getProvisionLogs = async (params: ListParams): Promise<Paginated<ProvisionLog>> =>
  unwrap(
    await apiRequest<Paginated<ProvisionLog>>(`/admin/provision-logs${listQuery(params)}`),
    t('Failed to fetch provisioning logs')
  );
