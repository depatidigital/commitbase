import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  getApplications, 
  getApplication, 
  createApplication, 
  updateApplication, 
  deleteApplication,
  startApplication,
  stopApplication,
  restartApplication,
  type Application,
  type CreateApplicationData,
  type UpdateApplicationData
} from '@/lib/applications';
import { useToast } from '@/hooks/use-toast';

export const useApplications = (page = 1, limit = 10) => {
  return useQuery({
    queryKey: ['applications', page, limit],
    queryFn: () => getApplications(page, limit),
    staleTime: 30000, // 30 seconds
  });
};

export const useApplication = (id: string) => {
  return useQuery({
    queryKey: ['application', id],
    queryFn: () => getApplication(id),
    enabled: !!id,
    staleTime: 30000, // 30 seconds
  });
};

export const useCreateApplication = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: createApplication,
    onSuccess: (data) => {
      toast({
        title: 'Success',
        description: 'Application created successfully',
      });
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

export const useUpdateApplication = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateApplicationData }) =>
      updateApplication(id, data),
    onSuccess: (data, variables) => {
      toast({
        title: 'Success',
        description: 'Application updated successfully',
      });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      queryClient.invalidateQueries({ queryKey: ['application', variables.id] });
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

export const useDeleteApplication = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: deleteApplication,
    onSuccess: (data, variables) => {
      toast({
        title: 'Success',
        description: 'Application deleted successfully',
      });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      queryClient.removeQueries({ queryKey: ['application', variables] });
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

export const useStartApplication = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: startApplication,
    onSuccess: (data, variables) => {
      toast({
        title: 'Success',
        description: 'Application started successfully',
      });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      queryClient.invalidateQueries({ queryKey: ['application', variables] });
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

export const useStopApplication = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: stopApplication,
    onSuccess: (data, variables) => {
      toast({
        title: 'Success',
        description: 'Application stopped successfully',
      });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      queryClient.invalidateQueries({ queryKey: ['application', variables] });
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

export const useRestartApplication = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: restartApplication,
    onSuccess: (data, variables) => {
      toast({
        title: 'Success',
        description: 'Application restarted successfully',
      });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      queryClient.invalidateQueries({ queryKey: ['application', variables] });
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