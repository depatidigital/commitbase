import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { 
  getDomains, 
  getDomainsPage,
  getDomain, 
  getDomainDnsZone,
  createDomain, 
  updateDomain, 
  deleteDomain, 
  verifyDomain, 
  syncDomains,
  bulkAssignDomains,
  getRdashDns,
  enableCloudflare,
  disableCloudflare,
  renewDomain,
  getDomainRegistration
} from '@/lib/domains';
import { CreateDomainData, UpdateDomainData } from '@/types/domain';
import { ListParams } from '@/lib/admin';

// Paged + searchable list for the domains table
export const useDomainsPage = (params: ListParams) => {
  return useQuery({
    queryKey: ['domains', 'page', params],
    queryFn: () => getDomainsPage(params),
  });
};

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

// Sync domains from RDASH + Cloudflare
export const useSyncDomains = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: syncDomains,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['domains'] });
      const failed = data.errors ? Object.values(data.errors).join(' ') : '';
      toast({
        title: failed ? 'Sync finished with errors' : 'Sync complete',
        description:
          `${data.total} domains — ${data.created} added, ${data.updated} updated ` +
          `(${data.rdashOnly} RDASH-only, ${data.cfOnly} Cloudflare-only). ${failed}`.trim(),
        variant: failed ? 'destructive' : undefined,
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'Failed to sync domains.',
        variant: 'destructive',
      });
    },
  });
};

// Assign several domains to one organization
export const useBulkAssignDomains = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ ids, organizationId }: { ids: string[]; organizationId: string | null }) =>
      bulkAssignDomains(ids, organizationId),
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast({
        title: 'Domains Assigned',
        description: `${count} domain(s) updated.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'Failed to assign domains.',
        variant: 'destructive',
      });
    },
  });
};

// DNS the registrar still holds — only meaningful for RDASH domains
export const useRdashDns = (id: string | null, enabled: boolean) => {
  return useQuery({
    queryKey: ['domains', id, 'rdash-dns'],
    queryFn: () => getRdashDns(id as string),
    enabled: !!id && enabled,
  });
};

export const useEnableCloudflare = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (id: string) => enableCloudflare(id),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast({
        title: data.warnings.length ? 'Cloudflare enabled with warnings' : 'Cloudflare enabled',
        description: [...data.steps, ...data.warnings].join(' · '),
        variant: data.warnings.length ? 'destructive' : undefined,
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'Failed to enable Cloudflare.',
        variant: 'destructive',
      });
    },
  });
};

export const useDisableCloudflare = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (id: string) => disableCloudflare(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast({
        title: 'Cloudflare detached',
        description:
          'The zone still exists in Cloudflare. Repoint the nameservers at your registrar before deleting it.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'Failed to disable Cloudflare.',
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

// Registrar renewal — RDASH only, spends reseller balance
export const useRenewDomain = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ id, years }: { id: string; years?: number }) => renewDomain(id, years),
    onSuccess: (message) => {
      queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast({ title: 'Renewal submitted', description: message });
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'Failed to renew domain.',
        variant: 'destructive',
      });
    },
  });
};

// Registry lookup — slow-ish and rarely changes, so cache it for the session
export const useDomainRegistration = (id: string | null) => {
  return useQuery({
    queryKey: ['domains', id, 'registration'],
    queryFn: () => getDomainRegistration(id as string),
    enabled: !!id,
    staleTime: 60 * 60 * 1000,
  });
};
