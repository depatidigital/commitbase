import { useQuery } from '@tanstack/react-query';
import { getGithubProjects, getGitlabProjects, type GitRepository } from '@/lib/git';

export const useGitProjects = (
  provider: 'github' | 'gitlab',
  enabled: boolean,
  accountId?: string,
) => {
  return useQuery<GitRepository[]>({
    queryKey: ['git', provider, 'projects', accountId || 'default'],
    queryFn: () =>
      provider === 'github'
        ? getGithubProjects(accountId)
        : getGitlabProjects(accountId),
    enabled,
  });
};
