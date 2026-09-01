import { useEffect, useRef, useState } from 'react';
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
  startDomainSync,
  getDomainSyncStatus,
  bulkAssignDomains,
  getRdashDns,
  enableCloudflare,
  disableCloudflare,
  renewDomain,
  getDomainRegistration,
  createDnsRecord,
  updateDnsRecord,
  deleteDnsRecord,
  DnsRecordInput,
  importRegistrarDns
} from '@/lib/domains';
import { isAdmin } from '@/lib/auth';
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

/**
 * Domain sync. The request only starts the run — it takes minutes, so the
 * status is polled until the backend reports it finished.
 */
export const useSyncDomains = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [polling, setPolling] = useState(false);
  const reported = useRef<string | null>(null);

  const status = useQuery({
    queryKey: ['domains', 'sync-status'],
    queryFn: getDomainSyncStatus,
    // the endpoint is admin-only, so do not even ask as a member
    enabled: isAdmin(),
    refetchInterval: polling ? 3000 : false,
  });

  // a run started by the cron job or another admin should show up here too
  useEffect(() => {
    if (status.data?.running) setPolling(true);
  }, [status.data?.running]);

  useEffect(() => {
    const state = status.data;
    if (!state || state.running || !state.finishedAt) return;
    // only announce a run we watched, and only once
    if (!polling || reported.current === state.finishedAt) return;

    reported.current = state.finishedAt;
    setPolling(false);
    queryClient.invalidateQueries({ queryKey: ['domains'] });

    if (state.error) {
      toast({
        title: 'Sync failed',
        description: state.error,
        variant: 'destructive',
      });
      return;
    }

    const result = state.result;
    if (!result) return;

    const failed = result.errors ? Object.values(result.errors).join(' ') : '';
    toast({
      title: failed ? 'Sync finished with errors' : 'Sync complete',
      description:
        `${result.total} domains — ${result.created} added, ${result.updated} updated ` +
        `(${result.rdashOnly} registrar-only, ${result.cfOnly} Cloudflare-only). ${failed}`.trim(),
      variant: failed ? 'destructive' : undefined,
    });
  }, [status.data, polling, queryClient, toast]);

  const start = useMutation({
    mutationFn: startDomainSync,
    onSuccess: () => {
      setPolling(true);
      toast({
        title: 'Sync started',
        description: 'Running in the background — the list updates when it finishes.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'Failed to start the domain sync.',
        variant: 'destructive',
      });
    },
  });

  return {
    mutate: start.mutate,
    // "pending" covers the whole run, not just the request that kicks it off
    isPending: start.isPending || polling || !!status.data?.running,
    state: status.data,
  };
};

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

// Subdomain / DNS record writes — all refresh the zone view they came from
const useDnsRecordMutation = <TArgs,>(
  domainId: string,
  fn: (args: TArgs) => Promise<unknown>,
  successTitle: string
) => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domains', domainId, 'dns-zone'] });
      toast({ title: successTitle });
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

export const useCreateDnsRecord = (domainId: string) =>
  useDnsRecordMutation<DnsRecordInput>(
    domainId,
    (record) => createDnsRecord(domainId, record),
    'DNS record created'
  );

export const useUpdateDnsRecord = (domainId: string) =>
  useDnsRecordMutation<{ recordId: string; record: DnsRecordInput }>(
    domainId,
    ({ recordId, record }) => updateDnsRecord(domainId, recordId, record),
    'DNS record updated'
  );

export const useDeleteDnsRecord = (domainId: string) =>
  useDnsRecordMutation<string>(
    domainId,
    (recordId) => deleteDnsRecord(domainId, recordId),
    'DNS record deleted'
  );

export const useImportRegistrarDns = (domainId: string) => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: () => importRegistrarDns(domainId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['domains', domainId, 'dns-zone'] });
      toast({
        title: data.imported === 0 ? 'Nothing to import' : 'Registrar DNS imported',
        description:
          (data as any).note ||
          `${data.imported} record(s) copied, ${data.skipped} already present.`,
      });
    },
    onError: (error: Error) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
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
