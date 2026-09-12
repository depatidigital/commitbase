import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { API_BASE_URL } from '@/lib/api';
import { t } from '@/lib/i18n';

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
  lines: number = 100,
  enabled: boolean = true
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
        throw new Error(t('Failed to fetch logs'));
      }
      
      return response.json();
    },
    enabled: !!applicationId && enabled,
    staleTime: 5000, // 5 seconds
    refetchInterval: 10000, // Refetch every 10 seconds
  });
};

// Scrollback kept in the browser; older lines fall off the top.
const MAX_LIVE_LINES = 2000;

/**
 * An app's log (pm2 or its systemd unit), live over SSE: the last `lines`
 * lines, then each new one. The connection is open only while `enabled`. fetch
 * rather than EventSource, which cannot send the Authorization header. A stream
 * the server ends is reopened after 3s; a refused one (too many streams) is not.
 */
export const useLiveLogs = (applicationId: string, logType: string, lines: number, enabled: boolean) => {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !applicationId) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = async () => {
      try {
        const response = await fetch(
          `${API_BASE_URL}/logs/application/${applicationId}/stream?type=${logType}&lines=${lines}`,
          {
            headers: { Authorization: `Bearer ${localStorage.getItem('authToken')}` },
            signal: controller.signal,
          }
        );
        if (!response.ok || !response.body) {
          const body = await response.json().catch(() => null);
          setError(body?.error || t('Failed to fetch logs'));
          return;
        }
        // the backlog is replayed on every connect
        setText('');
        setError(null);
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          const events = buffer.split('\n\n');
          buffer = events.pop() ?? '';
          const chunk = events
            .filter((event) => event.startsWith('data: '))
            .map((event) => JSON.parse(event.slice(6)) as string)
            .join('');
          if (chunk) setText((prev) => (prev + chunk).split('\n').slice(-MAX_LIVE_LINES).join('\n'));
        }
      } catch {
        // network drop: retried below unless we are the ones who aborted
      }
      if (!controller.signal.aborted) retry = setTimeout(connect, 3000);
    };

    connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [applicationId, logType, lines, enabled]);

  return { text, error };
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
        throw new Error(t('Failed to fetch build log status'));
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
        throw new Error(t('Failed to create test build log'));
      }
      
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: t('Success'),
        description: t('Test build log created successfully'),
      });
      queryClient.invalidateQueries({ queryKey: ['application-logs'] });
      queryClient.invalidateQueries({ queryKey: ['build-log-status'] });
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