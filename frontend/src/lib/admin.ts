import apiRequest from './api';

export type OrgRole = 'OWNER' | 'ADMIN' | 'MEMBER';

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
  if (res.success && res.data !== undefined) return res.data;
  throw new Error(res.error || fallback);
};

export const getUsers = async (): Promise<AdminUser[]> =>
  unwrap(await apiRequest<AdminUser[]>('/admin/users'), 'Failed to fetch users');

export const createUser = async (data: CreateUserData): Promise<AdminUser> =>
  unwrap(
    await apiRequest<AdminUser>('/admin/users', { method: 'POST', body: JSON.stringify(data) }),
    'Failed to create user'
  );

export const updateUser = async (
  id: string,
  data: { isActive?: boolean; role?: AdminUser['role']; name?: string }
): Promise<AdminUser> =>
  unwrap(
    await apiRequest<AdminUser>(`/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    'Failed to update user'
  );

export const getAdminDomains = async (): Promise<AdminDomain[]> =>
  unwrap(await apiRequest<AdminDomain[]>('/admin/domains'), 'Failed to fetch domains');

export const assignDomain = async (domainId: string, organizationId: string) =>
  unwrap(
    await apiRequest(`/admin/domains/${domainId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ organizationId }),
    }),
    'Failed to assign domain'
  );

export const unassignDomain = async (domainId: string) =>
  unwrap(
    await apiRequest(`/admin/domains/${domainId}/assign`, { method: 'DELETE' }),
    'Failed to unassign domain'
  );
