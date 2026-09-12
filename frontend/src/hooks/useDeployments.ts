import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  getDeploymentHistory, 
  getDeployment, 
  getDeploymentLogs,
  createDeployment, 
  updateDeployment, 
  deleteDeployment,
  type Deployment,
  type CreateDeploymentData,
  type UpdateDeploymentData
} from '@/lib/deployments';
import { activateRelease, getReleases, type Release } from '@/lib/applications';
import { useToast } from '@/hooks/use-toast';
import { t } from '@/lib/i18n';

/** Kept builds, newest first, and which one serves. */
export const useReleases = (appId: string) =>
  useQuery({ queryKey: ['releases', appId], queryFn: () => getReleases(appId), enabled: !!appId });

/** Switch back to a kept build — no rebuild. */
export const useRestoreRelease = (appId: string) => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (release: Release) => activateRelease(appId, release.id),
    onSuccess: () => toast({ title: t("Switched release"), description: t("The selected release is now serving.") }),
    onError: (error: Error) => toast({ variant: 'destructive', title: t("Error"), description: error.message }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['releases', appId] });
      queryClient.invalidateQueries({ queryKey: ['application', appId] });
      // a switch is recorded in the history, and changes which files serve
      queryClient.invalidateQueries({ queryKey: ['deployments', appId] });
      queryClient.invalidateQueries({ queryKey: ['site-files', appId] });
    },
  });
};

const IN_PROGRESS = ['PENDING', 'BUILDING', 'DEPLOYING'];

export const useDeploymentHistory = (appId: string, page = 1, limit = 10) => {
  return useQuery({
    queryKey: ['deployments', appId, page, limit],
    queryFn: () => getDeploymentHistory(appId, page, limit),
    enabled: !!appId,
    staleTime: 30000, // 30 seconds
    // follow a deploy while it runs, then settle
    refetchInterval: (query) =>
      query.state.data?.data.some((d) => IN_PROGRESS.includes(d.status)) ? 3000 : false,
  });
};

export const useDeployment = (deploymentId: string) => {
  return useQuery({
    queryKey: ['deployment', deploymentId],
    queryFn: () => getDeployment(deploymentId),
    enabled: !!deploymentId,
    staleTime: 30000, // 30 seconds
  });
};

export const useDeploymentLogs = (deploymentId: string, logType = 'build', lines = 100) => {
  return useQuery({
    queryKey: ['deployment-logs', deploymentId, logType, lines],
    queryFn: () => getDeploymentLogs(deploymentId, logType, lines),
    enabled: !!deploymentId,
    staleTime: 10000, // 10 seconds for logs
  });
};

export const useCreateDeployment = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ appId, data }: { appId: string; data: CreateDeploymentData }) =>
      createDeployment(appId, data),
    onSuccess: (data, variables) => {
      toast({
        title: t('Success'),
        description: t('Deployment created successfully'),
      });
      queryClient.invalidateQueries({ queryKey: ['deployments', variables.appId] });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
    },
    onError: (error: Error) => {
      toast({
        title: t('Error'),
        description: error.message,
        variant: 'destructive',
      });
    },
  });
};

export const useUpdateDeployment = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ deploymentId, data }: { deploymentId: string; data: UpdateDeploymentData }) =>
      updateDeployment(deploymentId, data),
    onSuccess: (data, variables) => {
      toast({
        title: t('Success'),
        description: t('Deployment updated successfully'),
      });
      queryClient.invalidateQueries({ queryKey: ['deployment', variables.deploymentId] });
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
    },
    onError: (error: Error) => {
      toast({
        title: t('Error'),
        description: error.message,
        variant: 'destructive',
      });
    },
  });
};

export const useDeleteDeployment = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: deleteDeployment,
    onSuccess: (data, variables) => {
      toast({
        title: t('Success'),
        description: t('Deployment deleted successfully'),
      });
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
      queryClient.removeQueries({ queryKey: ['deployment', variables] });
    },
    onError: (error: Error) => {
      toast({
        title: t('Error'),
        description: error.message,
        variant: 'destructive',
      });
    },
  });
}; 