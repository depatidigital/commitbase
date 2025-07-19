import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { API_BASE_URL } from '@/lib/api';

interface LogResponse {
  success: boolean;
  data: {
    logs: string;
    applicationId: string;
    domain: string;
    logType: string;
    lines: number;
  };
  message: string;
}

interface LogStatusResponse {
  success: boolean;
  data: {
    logStatus: {
      exists: boolean;
      path: string;
      size?: number;
    };
    domain: string;
    applicationId: string;
  };
  message: string;
}

// Fetch application logs
export const useApplicationLogs = (
  applicationId: string,
  logType: string = 'combined',
  lines: number = 100
) => {
  return useQuery({
    queryKey: ['application-logs', applicationId, logType, lines],
    queryFn: async (): Promise<LogResponse> => {
      const response = await fetch(
        `${API_BASE_URL}/logs/application/${applicationId}?type=${logType}&lines=${lines}`,
        {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
          },
        }
      );
      
      if (!response.ok) {
        throw new Error('Failed to fetch logs');
      }
      
      return response.json();
    },
    enabled: !!applicationId,
    staleTime: 5000, // 5 seconds
    refetchInterval: 10000, // Refetch every 10 seconds
  });
};

// Check build log status
export const useBuildLogStatus = (applicationId: string) => {
  return useQuery({
    queryKey: ['build-log-status', applicationId],
    queryFn: async (): Promise<LogStatusResponse> => {
      const response = await fetch(
        `${API_BASE_URL}/logs/build-log-status/${applicationId}`,
        {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
          },
        }
      );
      
      if (!response.ok) {
        throw new Error('Failed to fetch build log status');
      }
      
      return response.json();
    },
    enabled: !!applicationId,
    staleTime: 30000, // 30 seconds
  });
};

// Create test build log
export const useCreateTestBuildLog = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ applicationId, message }: { applicationId: string; message?: string }) => {
      const response = await fetch(
        `${API_BASE_URL}/logs/test-build-log/${applicationId}`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ message }),
        }
      );
      
      if (!response.ok) {
        throw new Error('Failed to create test build log');
      }
      
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: 'Success',
        description: 'Test build log created successfully',
      });
      queryClient.invalidateQueries({ queryKey: ['application-logs'] });
      queryClient.invalidateQueries({ queryKey: ['build-log-status'] });
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