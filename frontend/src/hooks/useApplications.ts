import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
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
  getApplicationHostname,
  setupApplicationDns,
  type Application,
  type CreateApplicationData,
  type UpdateApplicationData
} from '@/lib/applications';
import type { ListParams } from '@/lib/admin';
import { useToast } from '@/hooks/use-toast';
import { t } from '@/lib/i18n';
import { useEffect, useRef } from 'react';

/**
 * The apps list, kept fresh in the background: every 3s while a deploy is in
 * flight, otherwise every minute. The server returns it sorted, so each refetch
 * re-sorts the table. Previous rows stay on screen while a refetch or a new
 * sort/page loads — no skeleton flash.
 */
export const useApplicationsWithRealtime = (params: ListParams) => {
  const { data, isLoading, error } = useQuery({
    queryKey: ['applications', params],
    queryFn: () => getApplications(params),
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      query.state.data?.data.some((app) => app.status === 'DEPLOYING' || app.status === 'BUILDING')
        ? 3000
        : 60_000,
  });

  return { data, isLoading, error };
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
        title: t('Success'),
        description: t('App created successfully'),
      });
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

/**
 * Live reachability of the app's hostname. Polls while it is not serving yet —
 * DNS propagation and the first certificate take a minute or two.
 */
export const useApplicationHostname = (id: string, poll = false) => {
  return useQuery({
    queryKey: ['applications', id, 'hostname'],
    queryFn: () => getApplicationHostname(id),
    enabled: !!id,
    refetchInterval: (query) => (poll && !query.state.data?.live ? 5000 : false),
  });
};

export const useSetupApplicationDns = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) =>
      setupApplicationDns(id, force ?? false),
    onSuccess: (result, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['applications', id, 'hostname'] });
      queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast({ title: t('DNS updated'), description: result.detail });
    },
    onError: (error: Error) => {
      toast({
        title: t('DNS not set up'),
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
        title: t('Success'),
        description: t('App updated successfully'),
      });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      queryClient.invalidateQueries({ queryKey: ['application', variables.id] });
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

export const useDeleteApplication = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: deleteApplication,
    onSuccess: (data, variables) => {
      toast({
        title: t('Success'),
        description: t('App deleted successfully'),
      });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      queryClient.removeQueries({ queryKey: ['application', variables] });
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

export const useStartExistingApplication = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: startExistingApplication,
    onSuccess: (data, variables) => {
      toast({
        title: t('Success'),
        description: t('App is starting...'),
      });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      queryClient.invalidateQueries({ queryKey: ['application', variables] });
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

export const useStartApplication = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: startApplication,
    onSuccess: (data, variables) => {
      toast({
        title: t('Success'),
        description: t('App is starting...'),
      });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      queryClient.invalidateQueries({ queryKey: ['application', variables] });
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

export const useStopApplication = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: stopApplication,
    onSuccess: (data, variables) => {
      toast({
        title: t('Success'),
        description: t('App is stopping...'),
      });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      queryClient.invalidateQueries({ queryKey: ['application', variables] });
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

export const useRestartApplication = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: restartApplication,
    onSuccess: (data, variables) => {
      toast({
        title: t('Success'),
        description: t('App is restarting...'),
      });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      queryClient.invalidateQueries({ queryKey: ['application', variables] });
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
        title: t('Server apps synced'),
        description: t('{discovered} found — {created} imported, {updated} updated.', {
          discovered: result.discovered,
          created: result.created,
          updated: result.updated,
        }),
        ...(result.errors?.length ? { variant: 'destructive' as const } : {}),
      });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
    },
    onError: (error: Error) => {
      toast({
        title: t('Sync failed'),
        description: error.message,
        variant: 'destructive',
      });
    },
  });
};
