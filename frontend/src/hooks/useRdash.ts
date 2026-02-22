import { useQuery } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { getRdashSummary, getCloudflareZones, getRdashConfigStatus, getCloudflareConfigStatus, RdashSummary, RdashConfigStatus, CloudflareConfigStatus } from '@/lib/rdash';

export const useRdashSummary = () => {
  const { toast } = useToast();

  return useQuery<RdashSummary>({
    queryKey: ['rdash', 'summary'],
    queryFn: async () => {
      try {
        return await getRdashSummary();
      } catch (error: any) {
        toast({
          title: 'Failed to load RDASH summary',
          description: error.message || 'Unable to fetch RDASH account and domains',
          variant: 'destructive',
        });
        throw error;
      }
    },
  });
};

export const useCloudflareZones = (page?: number, perPage?: number) => {
  const { toast } = useToast();

  return useQuery<any[]>({
    queryKey: ['cloudflare', 'zones', { page, perPage }],
    queryFn: async () => {
      try {
        return await getCloudflareZones(page, perPage);
      } catch (error: any) {
        toast({
          title: 'Failed to load Cloudflare zones',
          description: error.message || 'Unable to fetch Cloudflare domains',
          variant: 'destructive',
        });
        throw error;
      }
    },
  });
};

export const useRdashConfigStatus = () => {
  const { toast } = useToast();

  return useQuery<RdashConfigStatus>({
    queryKey: ['integrations', 'rdash-config'],
    queryFn: async () => {
      try {
        return await getRdashConfigStatus();
      } catch (error: any) {
        toast({
          title: 'Failed to load RDASH config',
          description: error.message || 'Unable to fetch RDASH configuration',
          variant: 'destructive',
        });
        throw error;
      }
    },
  });
};

export const useCloudflareConfigStatus = () => {
  const { toast } = useToast();

  return useQuery<CloudflareConfigStatus>({
    queryKey: ['integrations', 'cloudflare-config'],
    queryFn: async () => {
      try {
        return await getCloudflareConfigStatus();
      } catch (error: any) {
        toast({
          title: 'Failed to load Cloudflare config',
          description: error.message || 'Unable to fetch Cloudflare configuration',
          variant: 'destructive',
        });
        throw error;
      }
    },
  });
};
