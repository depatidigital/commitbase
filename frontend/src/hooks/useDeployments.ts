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
import { useToast } from '@/hooks/use-toast';

export const useDeploymentHistory = (appId: string, page = 1, limit = 10) => {
  return useQuery({
    queryKey: ['deployments', appId, page, limit],
    queryFn: () => getDeploymentHistory(appId, page, limit),
    enabled: !!appId,
    staleTime: 30000, // 30 seconds
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
        title: 'Success',
        description: 'Deployment created successfully',
      });
      queryClient.invalidateQueries({ queryKey: ['deployments', variables.appId] });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
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
        title: 'Success',
        description: 'Deployment updated successfully',
      });
      queryClient.invalidateQueries({ queryKey: ['deployment', variables.deploymentId] });
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
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
        title: 'Success',
        description: 'Deployment deleted successfully',
      });
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
      queryClient.removeQueries({ queryKey: ['deployment', variables] });
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive',
      });
    },
  });
}; 