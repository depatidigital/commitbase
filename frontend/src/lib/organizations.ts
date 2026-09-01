import apiRequest from './api';
import { OrgRole, ListParams, listQuery } from './admin';
import type { Paginated } from '@/components/DataTable';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  myRole: OrgRole | null;
  _count: { members: number; domains: number; applications: number };
}

export interface Member {
  id: string;
  role: OrgRole;
  createdAt: string;
  user: { id: string; email: string; name: string | null; isActive: boolean };
}

export interface Invite {
  id: string;
  email: string;
  role: OrgRole;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

// Returned only when the invite is created — the token is stored hashed and never re-readable.
export interface CreatedInvite extends Invite {
  token: string;
  acceptUrl: string | null;
  // false when SMTP is unconfigured or the send failed — the link still works
  emailed?: boolean;
}

const unwrap = <T>(res: { success: boolean; data?: T; error?: string }, fallback: string): T => {
  // DELETE routes answer { success: true } with no body — that is still a success
  if (res.success) return res.data as T;
  throw new Error(res.error || fallback);
};

export const getOrganizations = async (): Promise<Organization[]> =>
  unwrap(await apiRequest<Organization[]>('/organizations'), 'Failed to fetch organizations');

export const getOrganizationsPage = async (params: ListParams): Promise<Paginated<Organization>> =>
  unwrap(
    await apiRequest<Paginated<Organization>>(`/organizations${listQuery(params)}`),
    'Failed to fetch organizations'
  );

export const getOrganization = async (id: string): Promise<Organization> =>
  unwrap(await apiRequest<Organization>(`/organizations/${id}`), 'Failed to fetch organization');

// no account with that email? the backend issues an invite instead of failing
export type AddMemberResult = Member | { invited: true; invite: CreatedInvite };

export const isInviteResult = (
  r: AddMemberResult
): r is { invited: true; invite: CreatedInvite } => 'invited' in r;

export const addMember = async (
  orgId: string,
  data: { email: string; role?: OrgRole }
): Promise<AddMemberResult> =>
  unwrap(
    await apiRequest<AddMemberResult>(`/organizations/${orgId}/members`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
    'Failed to add member'
  );

export const createOrganization = async (data: { name: string; slug?: string }): Promise<Organization> =>
  unwrap(
    await apiRequest<Organization>('/organizations', { method: 'POST', body: JSON.stringify(data) }),
    'Failed to create organization'
  );

export const getMembers = async (orgId: string): Promise<Member[]> =>
  unwrap(await apiRequest<Member[]>(`/organizations/${orgId}/members`), 'Failed to fetch members');

export const updateMemberRole = async (orgId: string, userId: string, role: OrgRole) =>
  unwrap(
    await apiRequest(`/organizations/${orgId}/members/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    }),
    'Failed to update member'
  );

export const removeMember = async (orgId: string, userId: string) =>
  unwrap(
    await apiRequest(`/organizations/${orgId}/members/${userId}`, { method: 'DELETE' }),
    'Failed to remove member'
  );

export const getInvites = async (orgId: string): Promise<Invite[]> =>
  unwrap(await apiRequest<Invite[]>(`/organizations/${orgId}/invites`), 'Failed to fetch invites');

// an email that already has an account is added as a member instead of invited
export type InviteResult = CreatedInvite | { added: true; membership: Member };

export const isMemberAdded = (
  r: InviteResult
): r is { added: true; membership: Member } => 'added' in r;

export const createInvite = async (
  orgId: string,
  data: { email: string; role?: OrgRole }
): Promise<InviteResult> =>
  unwrap(
    await apiRequest<InviteResult>(`/organizations/${orgId}/invites`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
    'Failed to create invite'
  );

export const revokeInvite = async (orgId: string, inviteId: string) =>
  unwrap(
    await apiRequest(`/organizations/${orgId}/invites/${inviteId}`, { method: 'DELETE' }),
    'Failed to revoke invite'
  );

export interface InvitePreview {
  email: string;
  role: OrgRole;
  organizationName: string;
  expiresAt: string;
  needsPassword: boolean;
}

export const getInvitePreview = async (token: string): Promise<InvitePreview> =>
  unwrap(
    await apiRequest<InvitePreview>(`/auth/invite/${encodeURIComponent(token)}`),
    'This invite link is invalid or has expired'
  );

export const acceptInvite = async (data: { token: string; name?: string; password?: string }) =>
  unwrap(
    await apiRequest<{ user: unknown; token: string; organizationId: string }>('/auth/accept-invite', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
    'Failed to accept invite'
  );
