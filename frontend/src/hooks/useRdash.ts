import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { t } from '@/lib/i18n';
import { getRdashSummary, getCloudflareZones, getRdashConfigStatus, getCloudflareConfigStatus, updateRdashConfig, updateCloudflareConfig, RdashSummary, RdashConfigStatus, CloudflareConfigStatus, RdashConfigUpdatePayload, CloudflareConfigUpdatePayload } from '@/lib/rdash';

export const useRdashSummary = (enabled: boolean = true) => {
  const { toast } = useToast();

  return useQuery<RdashSummary>({
    queryKey: ['rdash', 'summary'],
    queryFn: async () => {
      try {
        return await getRdashSummary();
      } catch (error: any) {
        toast({
          title: t('Failed to load RDASH summary'),
          description: error.message || t('Unable to fetch RDASH account and domains'),
          variant: 'destructive',
        });
        throw error;
      }
    },
    enabled,
  });
};

export const useCloudflareZones = (page?: number, perPage?: number, enabled: boolean = true) => {
  const { toast } = useToast();

  return useQuery<any[]>({
    queryKey: ['cloudflare', 'zones', { page, perPage }],
    queryFn: async () => {
      try {
        return await getCloudflareZones(page, perPage);
      } catch (error: any) {
        toast({
          title: t('Failed to load Cloudflare zones'),
          description: error.message || t('Unable to fetch Cloudflare domains'),
          variant: 'destructive',
        });
        throw error;
      }
    },
    enabled,
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
          title: t('Failed to load RDASH config'),
          description: error.message || t('Unable to fetch RDASH configuration'),
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
          title: t('Failed to load Cloudflare config'),
          description: error.message || t('Unable to fetch Cloudflare configuration'),
          variant: 'destructive',
        });
        throw error;
      }
    },
  });
};

export const useUpdateRdashConfig = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (payload: RdashConfigUpdatePayload) => updateRdashConfig(payload),
    onSuccess: () => {
      toast({
        title: t('RDASH config updated'),
        description: t('RDASH configuration has been saved.'),
      });
      queryClient.invalidateQueries({ queryKey: ['integrations', 'rdash-config'] });
    },
    onError: (error: Error) => {
      toast({
        title: t('Failed to update RDASH config'),
        description: error.message || t('Unable to save RDASH configuration'),
        variant: 'destructive',
      });
    },
  });
};

export const useUpdateCloudflareConfig = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (payload: CloudflareConfigUpdatePayload) => updateCloudflareConfig(payload),
    onSuccess: () => {
      toast({
        title: t('Cloudflare config updated'),
        description: t('Cloudflare configuration has been saved.'),
      });
      queryClient.invalidateQueries({ queryKey: ['integrations', 'cloudflare-config'] });
    },
    onError: (error: Error) => {
      toast({
        title: t('Failed to update Cloudflare config'),
        description: error.message || t('Unable to save Cloudflare configuration'),
        variant: 'destructive',
      });
    },
  });
};
