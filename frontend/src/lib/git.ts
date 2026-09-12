import apiRequest from './api';
import { t } from './i18n';

export interface GitAccount {
  id: string;
  externalId: string;
  username: string;
  displayName: string;
  provider: 'github' | 'gitlab';
}

export const updateGitAccountDisplayName = async (
  id: string,
  displayName: string,
): Promise<GitAccount> => {
  const response = await apiRequest<GitAccount>(`/git/accounts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ displayName }),
  });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t('Failed to update git account'));
};

export const deleteGitAccount = async (id: string): Promise<void> => {
  const response = await apiRequest(`/git/accounts/${id}`, {
    method: 'DELETE',
  });

  if (!response.success) {
    throw new Error(response.error || t('Failed to delete git account'));
  }
};

export const getGithubAccounts = async (): Promise<GitAccount[]> => {
  const response = await apiRequest<GitAccount[]>('/git/github/accounts');

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t('Failed to fetch GitHub accounts'));
};

export const getGitlabAccounts = async (): Promise<GitAccount[]> => {
  const response = await apiRequest<GitAccount[]>('/git/gitlab/accounts');

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t('Failed to fetch GitLab accounts'));
};

export const getGithubAuthUrl = async (): Promise<string> => {
  const response = await apiRequest<{ url: string }>('/git/github/auth/url');

  if (response.success && response.data?.url) {
    return response.data.url;
  }

  throw new Error(response.error || t('Failed to get GitHub OAuth URL'));
};

export const getGitlabAuthUrl = async (): Promise<string> => {
  const response = await apiRequest<{ url: string }>('/git/gitlab/auth/url');

  if (response.success && response.data?.url) {
    return response.data.url;
  }

  throw new Error(response.error || t('Failed to get GitLab OAuth URL'));
};
