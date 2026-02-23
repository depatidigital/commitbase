import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { 
  getDomains, 
  getDomain, 
  getDomainDnsZone,
  createDomain, 
  updateDomain, 
  deleteDomain, 
  verifyDomain, 
  renewSSL 
} from '@/lib/domains';
import { CreateDomainData, UpdateDomainData } from '@/types/domain';

// Get all domains
export const useDomains = () => {
  return useQuery({
    queryKey: ['domains'],
    queryFn: getDomains,
  });
};

// Get a specific domain
export const useDomain = (id: string) => {
  return useQuery({
    queryKey: ['domains', id],
    queryFn: () => getDomain(id),
    enabled: !!id,
  });
};

export const useDomainDnsZone = (id: string | null) => {
  return useQuery({
    queryKey: ['domains', id, 'dns-zone'],
    queryFn: () => getDomainDnsZone(id as string),
    enabled: !!id,
  });
};

// Create domain mutation
export const useCreateDomain = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (data: CreateDomainData) => createDomain(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast({
        title: 'Domain Created',
        description: 'Domain has been created successfully.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'Failed to create domain.',
        variant: 'destructive',
      });
    },
  });
};

// Update domain mutation
export const useUpdateDomain = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateDomainData }) => 
      updateDomain(id, data),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['domains'] });
      queryClient.invalidateQueries({ queryKey: ['domains', id] });
      toast({
        title: 'Domain Updated',
        description: 'Domain has been updated successfully.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'Failed to update domain.',
        variant: 'destructive',
      });
    },
  });
};

// Delete domain mutation
export const useDeleteDomain = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (id: string) => deleteDomain(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast({
        title: 'Domain Deleted',
        description: 'Domain has been deleted successfully.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'Failed to delete domain.',
        variant: 'destructive',
      });
    },
  });
};

// Verify domain mutation
export const useVerifyDomain = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (id: string) => verifyDomain(id),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['domains'] });
      if (data.verified) {
        toast({
          title: 'Domain Verified',
          description: 'Domain DNS has been verified successfully.',
        });
      } else {
        toast({
          title: 'Verification Failed',
          description: 'Domain DNS verification failed. Please check your DNS settings.',
          variant: 'destructive',
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'Failed to verify domain.',
        variant: 'destructive',
      });
    },
  });
};

// Renew SSL mutation
export const useRenewSSL = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (id: string) => renewSSL(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast({
        title: 'SSL Renewed',
        description: 'SSL certificate has been renewed successfully.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'Failed to renew SSL certificate.',
        variant: 'destructive',
      });
    },
  });
}; 
