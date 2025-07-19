import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  getLogs, 
  clearLogs, 
  exportLogs,
  type Log,
  type LogFilters
} from '@/lib/logs';
import { useToast } from '@/hooks/use-toast';

export const useLogs = (
  applicationId: string, 
  page = 1, 
  limit = 50, 
  filters?: LogFilters
) => {
  return useQuery({
    queryKey: ['logs', applicationId, page, limit, filters],
    queryFn: () => getLogs(applicationId, page, limit, filters),
    enabled: !!applicationId,
    staleTime: 10000, // 10 seconds for logs
    refetchInterval: 5000, // Refetch every 5 seconds for real-time updates
  });
};

export const useClearLogs = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: clearLogs,
    onSuccess: (data, variables) => {
      toast({
        title: 'Success',
        description: 'Logs cleared successfully',
      });
      queryClient.invalidateQueries({ queryKey: ['logs', variables] });
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

export const useExportLogs = () => {
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ 
      applicationId, 
      format, 
      filters 
    }: { 
      applicationId: string; 
      format?: 'json' | 'csv'; 
      filters?: LogFilters;
    }) => exportLogs(applicationId, format, filters),
    onSuccess: (blob, variables) => {
      // Create download link
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `logs-${variables.applicationId}-${new Date().toISOString().split('T')[0]}.${variables.format || 'json'}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      toast({
        title: 'Success',
        description: 'Logs exported successfully',
      });
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