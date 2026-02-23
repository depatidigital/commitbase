import { useQuery } from '@tanstack/react-query';
import {
  getGithubBranches,
  getGitlabBranches,
  type GitBranch,
} from '@/lib/git';

export const useGitBranches = (
  provider: 'github' | 'gitlab',
  projectId: string,
  enabled: boolean,
  accountId?: string,
) => {
  return useQuery<GitBranch[]>({
    queryKey: ['git', provider, 'branches', projectId, accountId || 'default'],
    queryFn: () =>
      provider === 'github'
        ? getGithubBranches(projectId, accountId)
        : getGitlabBranches(projectId, accountId),
    enabled: enabled && !!projectId,
  });
};
