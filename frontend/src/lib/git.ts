import apiRequest from './api';

export interface GitRepository {
  id: string;
  name: string;
  fullName: string;
  cloneUrl: string;
  sshUrl?: string;
  provider: 'github' | 'gitlab';
  accountId: string;
  workspace?: string;
}

export interface GitBranch {
  name: string;
}

export interface GitConnectionStatus {
  githubConnected: boolean;
  gitlabConnected: boolean;
}

export interface GitAccount {
  id: string;
  externalId: string;
  username: string;
  displayName: string;
  provider: 'github' | 'gitlab';
}

export const getGithubAccounts = async (): Promise<GitAccount[]> => {
  const response = await apiRequest<GitAccount[]>('/git/github/accounts');

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to fetch GitHub accounts');
};

export const getGitlabAccounts = async (): Promise<GitAccount[]> => {
  const response = await apiRequest<GitAccount[]>('/git/gitlab/accounts');

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to fetch GitLab accounts');
};

export const getGithubProjects = async (
  accountId?: string,
): Promise<GitRepository[]> => {
  const endpoint = accountId
    ? `/git/github/projects?accountId=${encodeURIComponent(accountId)}`
    : '/git/github/projects';
  const response = await apiRequest<GitRepository[]>(endpoint);

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to fetch GitHub repositories');
};

export const getGitlabProjects = async (
  accountId?: string,
): Promise<GitRepository[]> => {
  const endpoint = accountId
    ? `/git/gitlab/projects?accountId=${encodeURIComponent(accountId)}`
    : '/git/gitlab/projects';
  const response = await apiRequest<GitRepository[]>(endpoint);

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to fetch GitLab projects');
};

export const getGithubBranches = async (
  projectId: string,
  accountId?: string,
): Promise<GitBranch[]> => {
  const base = `/git/github/projects/${projectId}/branches`;
  const endpoint = accountId
    ? `${base}?accountId=${encodeURIComponent(accountId)}`
    : base;
  const response = await apiRequest<GitBranch[]>(endpoint);

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to fetch GitHub branches');
};

export const getGitlabBranches = async (
  projectId: string,
  accountId?: string,
): Promise<GitBranch[]> => {
  const base = `/git/gitlab/projects/${projectId}/branches`;
  const endpoint = accountId
    ? `${base}?accountId=${encodeURIComponent(accountId)}`
    : base;
  const response = await apiRequest<GitBranch[]>(endpoint);

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to fetch GitLab branches');
};

export const getGithubAuthUrl = async (): Promise<string> => {
  const response = await apiRequest<{ url: string }>('/git/github/auth/url');

  if (response.success && response.data?.url) {
    return response.data.url;
  }

  throw new Error(response.error || 'Failed to get GitHub OAuth URL');
};

export const getGitlabAuthUrl = async (): Promise<string> => {
  const response = await apiRequest<{ url: string }>('/git/gitlab/auth/url');

  if (response.success && response.data?.url) {
    return response.data.url;
  }

  throw new Error(response.error || 'Failed to get GitLab OAuth URL');
};

export const getGitConnectionStatus = async (): Promise<GitConnectionStatus> => {
  const response = await apiRequest<GitConnectionStatus>('/git/status');

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || 'Failed to get git connection status');
};
