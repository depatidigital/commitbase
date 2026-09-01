import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  getApplications, 
  getApplication, 
  createApplication, 
  updateApplication, 
  deleteApplication, 
  startApplication, 
  startExistingApplication,
  stopApplication, 
  restartApplication,
  syncServerApps,
  type Application,
  type CreateApplicationData,
  type UpdateApplicationData
} from '@/lib/applications';
import { useToast } from '@/hooks/use-toast';
import { useEffect, useRef } from 'react';

export const useApplications = (page = 1, limit = 10, search = '') => {
  return useQuery({
    queryKey: ['applications', page, limit, search],
    queryFn: () => getApplications(page, limit, search),
    staleTime: 30000, // 30 seconds
  });
};

// Real-time applications list monitoring hook
export const useApplicationsWithRealtime = (page = 1, limit = 10, search = '') => {
  const queryClient = useQueryClient();
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  
  const { data: applicationsData, isLoading, error } = useApplications(page, limit, search);
  
  useEffect(() => {
    // Check if any application is deploying or building
    const hasDeployingApps = applicationsData?.data?.some(
      app => app.status === 'DEPLOYING' || app.status === 'BUILDING'
    );
    
    if (hasDeployingApps) {
      // Clear any existing interval
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      
      // Start polling every 3 seconds
      intervalRef.current = setInterval(() => {
        queryClient.invalidateQueries({ queryKey: ['applications', page, limit, search] });
      }, 3000);
      
      return () => {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
        }
      };
    } else {
      // Clear interval if no deploying apps
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
  }, [applicationsData?.data, page, limit, queryClient]);
  
  return { data: applicationsData, isLoading, error };
};

export const useApplication = (id: string) => {
  return useQuery({
    queryKey: ['application', id],
    queryFn: () => getApplication(id),
    enabled: !!id,
    staleTime: 30000, // 30 seconds
  });
};

// Real-time status monitoring hook
export const useApplicationStatus = (id: string) => {
  const queryClient = useQueryClient();
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  
  const { data: application, isLoading, error } = useApplication(id);
  
  useEffect(() => {
    // Only start polling if application is deploying or building
    if (application?.status === 'DEPLOYING' || application?.status === 'BUILDING') {
      // Clear any existing interval
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      
      // Start polling every 2 seconds
      intervalRef.current = setInterval(() => {
        queryClient.invalidateQueries({ queryKey: ['application', id] });
      }, 2000);
      
      return () => {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
        }
      };
    } else {
      // Clear interval if not deploying
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
  }, [application?.status, id, queryClient]);
  
  return { application, isLoading, error };
};

export const useCreateApplication = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: createApplication,
    onSuccess: (data) => {
      toast({
        title: 'Success',
        description: 'App created successfully',
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
        description: 'App updated successfully',
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
        description: 'App deleted successfully',
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

export const useStartExistingApplication = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: startExistingApplication,
    onSuccess: (data, variables) => {
      toast({
        title: 'Success',
        description: 'App is starting...',
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

export const useStartApplication = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: startApplication,
    onSuccess: (data, variables) => {
      toast({
        title: 'Success',
        description: 'App is starting...',
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
        description: 'App is stopping...',
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
        description: 'App is restarting...',
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
/**
 * Superadmin-only: scan pm2 + /etc/caddy/sites and import what is running.
 */
export const useSyncServerApps = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: syncServerApps,
    onSuccess: (result) => {
      toast({
        title: 'Server apps synced',
        description: `${result.discovered} found — ${result.created} imported, ${result.updated} updated.`,
        ...(result.errors?.length ? { variant: 'destructive' as const } : {}),
      });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
    },
    onError: (error: Error) => {
      toast({
        title: 'Sync failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });
};
