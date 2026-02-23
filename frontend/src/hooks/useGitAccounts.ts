import { useQuery } from '@tanstack/react-query';
import { getGithubAccounts, getGitlabAccounts, type GitAccount } from '@/lib/git';

export const useGitAccounts = (
  provider: 'github' | 'gitlab',
  enabled: boolean,
) => {
  return useQuery<GitAccount[]>({
    queryKey: ['git', provider, 'accounts'],
    queryFn: () =>
      provider === 'github' ? getGithubAccounts() : getGitlabAccounts(),
    enabled,
  });
};

