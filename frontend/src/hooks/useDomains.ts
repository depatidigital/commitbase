import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { t } from "@/lib/i18n";
import {
  getDomains,
  getDomainsPage,
  getDomain,
  getDomainDnsZone,
  getPlatformTarget,
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
  importRegistrarDns,
  getSearchTlds,
  checkDomain,
  suggestDomains,
  registerDomain,
  DomainOffer,
  isProvisioning,
  setupWildcard,
} from "@/lib/domains";
import { isAdmin } from "@/lib/auth";
import { CreateDomainData, UpdateDomainData } from "@/types/domain";
import { ListParams } from "@/lib/admin";

// Paged + searchable list for the domains table
export const useDomainsPage = (params: ListParams) => {
  return useQuery({
    queryKey: ["domains", "page", params],
    queryFn: () => getDomainsPage(params),
    // registrations finish in the background — poll while any row is mid-purchase
    refetchInterval: (query) =>
      query.state.data?.data.some(isProvisioning) ? 5000 : false,
  });
};

// Get all domains
export const useDomains = () => {
  return useQuery({
    queryKey: ["domains"],
    queryFn: getDomains,
  });
};

// Get a specific domain
export const useDomain = (id: string) => {
  return useQuery({
    queryKey: ["domains", id],
    queryFn: () => getDomain(id),
    enabled: !!id,
  });
};

export const useDomainDnsZone = (id: string | null) => {
  return useQuery({
    queryKey: ["domains", id, "dns-zone"],
    queryFn: () => getDomainDnsZone(id as string),
    enabled: !!id,
  });
};

export const usePlatformTarget = () => {
  return useQuery({
    queryKey: ["domains", "platform-target"],
    queryFn: getPlatformTarget,
    staleTime: 5 * 60 * 1000,
  });
};

// Create domain mutation
export const useCreateDomain = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (data: CreateDomainData) => createDomain(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["domains"] });
      toast({
        title: t("Domain Created"),
        description: t("Domain has been created successfully."),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("Error"),
        description: error.message || t("Failed to create domain."),
        variant: "destructive",
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
    queryKey: ["domains", "sync-status"],
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
    queryClient.invalidateQueries({ queryKey: ["domains"] });

    if (state.error) {
      toast({
        title: t("Sync failed"),
        description: state.error,
        variant: "destructive",
      });
      return;
    }

    const result = state.result;
    if (!result) return;

    const failed = result.errors ? Object.values(result.errors).join(" ") : "";
    toast({
      title: failed ? t("Sync finished with errors") : t("Sync complete"),
      description:
        `${t(
          "{total} domains — {created} added, {updated} updated ({rdashOnly} registrar-only, {cfOnly} Cloudflare-only).",
          {
            total: result.total,
            created: result.created,
            updated: result.updated,
            rdashOnly: result.rdashOnly,
            cfOnly: result.cfOnly,
          },
        )} ${failed}`.trim(),
      variant: failed ? "destructive" : undefined,
    });
  }, [status.data, polling, queryClient, toast]);

  const start = useMutation({
    mutationFn: startDomainSync,
    onSuccess: () => {
      setPolling(true);
      toast({
        title: t("Sync started"),
        description:
          t("Running in the background — the list updates when it finishes."),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("Error"),
        description: error.message || t("Failed to start the domain sync."),
        variant: "destructive",
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
    mutationFn: ({
      ids,
      organizationId,
    }: {
      ids: string[];
      organizationId: string | null;
    }) => bulkAssignDomains(ids, organizationId),
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ["domains"] });
      toast({
        title: t("Domains Assigned"),
        description: t("{count} domain(s) updated.", { count }),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("Error"),
        description: error.message || t("Failed to assign domains."),
        variant: "destructive",
      });
    },
  });
};

// DNS the registrar still holds — only meaningful for RDASH domains
export const useRdashDns = (id: string | null, enabled: boolean) => {
  return useQuery({
    queryKey: ["domains", id, "rdash-dns"],
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
      queryClient.invalidateQueries({ queryKey: ["domains"] });
      toast({
        title: data.warnings.length
          ? t("Cloudflare enabled with warnings")
          : t("Cloudflare enabled"),
        description: [...data.steps, ...data.warnings].join(" · "),
        variant: data.warnings.length ? "destructive" : undefined,
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("Error"),
        description: error.message || t("Failed to enable Cloudflare."),
        variant: "destructive",
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
      queryClient.invalidateQueries({ queryKey: ["domains"] });
      toast({
        title: t("Cloudflare detached"),
        description:
          t("The zone still exists in Cloudflare. Repoint the nameservers at your registrar before deleting it."),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("Error"),
        description: error.message || t("Failed to disable Cloudflare."),
        variant: "destructive",
      });
    },
  });
};

// Subdomain / DNS record writes — all refresh the zone view they came from
const useDnsRecordMutation = <TArgs>(
  domainId: string,
  fn: (args: TArgs) => Promise<unknown>,
  successTitle: string,
) => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["domains", domainId, "dns-zone"],
      });
      toast({ title: successTitle });
    },
    onError: (error: Error) => {
      toast({
        title: t("Error"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
};

export const useCreateDnsRecord = (domainId: string) =>
  useDnsRecordMutation<DnsRecordInput>(
    domainId,
    (record) => createDnsRecord(domainId, record),
    t("DNS record created"),
  );

export const useUpdateDnsRecord = (domainId: string) =>
  useDnsRecordMutation<{ recordId: string; record: DnsRecordInput }>(
    domainId,
    ({ recordId, record }) => updateDnsRecord(domainId, recordId, record),
    t("DNS record updated"),
  );

export const useDeleteDnsRecord = (domainId: string) =>
  useDnsRecordMutation<string>(
    domainId,
    (recordId) => deleteDnsRecord(domainId, recordId),
    t("DNS record deleted"),
  );

export const useImportRegistrarDns = (domainId: string) => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: () => importRegistrarDns(domainId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: ["domains", domainId, "dns-zone"],
      });
      toast({
        title:
          data.imported === 0 ? t("Nothing to import") : t("Registrar DNS imported"),
        description:
          (data as any).note ||
          t("{imported} record(s) copied, {skipped} already present.", {
            imported: data.imported,
            skipped: data.skipped,
          }),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("Error"),
        description: error.message,
        variant: "destructive",
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
      queryClient.invalidateQueries({ queryKey: ["domains"] });
      queryClient.invalidateQueries({ queryKey: ["domains", id] });
      toast({
        title: t("Domain Updated"),
        description: t("Domain has been updated successfully."),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("Error"),
        description: error.message || t("Failed to update domain."),
        variant: "destructive",
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
      queryClient.invalidateQueries({ queryKey: ["domains"] });
      toast({
        title: t("Domain Deleted"),
        description: t("Domain has been deleted successfully."),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("Error"),
        description: error.message || t("Failed to delete domain."),
        variant: "destructive",
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
      queryClient.invalidateQueries({ queryKey: ["domains"] });
      if (data.verified) {
        toast({
          title: t("Domain Verified"),
          description: t("Domain DNS has been verified successfully."),
        });
      } else {
        toast({
          title: t("Verification Failed"),
          description:
            t("Domain DNS verification failed. Please check your DNS settings."),
          variant: "destructive",
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: t("Error"),
        description: error.message || t("Failed to verify domain."),
        variant: "destructive",
      });
    },
  });
};

// Registrar renewal — RDASH only, spends reseller balance
export const useRenewDomain = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ id, years }: { id: string; years?: number }) =>
      renewDomain(id, years),
    onSuccess: (message) => {
      queryClient.invalidateQueries({ queryKey: ["domains"] });
      toast({ title: t("Renewal submitted"), description: message });
    },
    onError: (error: Error) => {
      toast({
        title: t("Error"),
        description: error.message || t("Failed to renew domain."),
        variant: "destructive",
      });
    },
  });
};

// Registry lookup — slow-ish and rarely changes, so cache it for the session
export const useDomainRegistration = (id: string | null) => {
  return useQuery({
    queryKey: ["domains", id, "registration"],
    queryFn: () => getDomainRegistration(id as string),
    enabled: !!id,
    staleTime: 60 * 60 * 1000,
  });
};

/**
 * Domain search for the register flow.
 *
 * Two phases so the dialog is never a blank spinner: the TLD list (with
 * prices) comes back immediately and paints every row, then availability is
 * checked one request per row and each row fills in as its answer lands.
 *
 * A few checks run at once here; the backend's own RDAP gate is what actually
 * protects the registries, so this pool only needs to keep the browser tidy.
 */
const CHECK_POOL = 3;

/** How many free names the AI loop aims for, and how many batches it may ask for. */
const SUGGEST_TARGET = 5;
const SUGGEST_ROUNDS = 3;

export const useDomainSearch = () => {
  const { toast } = useToast();
  const [offers, setOffers] = useState<DomainOffer[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  // bumped on every new search and on reset, so answers from an abandoned
  // search cannot land in the list the user is now looking at
  const runId = useRef(0);
  // names already proposed, so "load more" gets fresh ideas instead of repeats
  const seen = useRef<string[]>([]);

  const patch = (domain: string, fields: Partial<DomainOffer>) =>
    setOffers((prev) =>
      prev
        ? prev.map((row) =>
            row.domain === domain ? { ...row, ...fields } : row,
          )
        : prev,
    );

  /**
   * Check every row a few at a time, patching each as its answer lands.
   * Returns how many came back free, which is what the AI loop needs to know.
   */
  const resolveAvailability = async (rows: DomainOffer[], run: number) => {
    const queue = [...rows];
    let free = 0;

    const worker = async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        try {
          const result = await checkDomain(row.domain);
          if (runId.current !== run) return;
          if (result.available === true && !result.owned) free++;
          patch(row.domain, result);
        } catch {
          if (runId.current !== run) return;
          // our own request failed — say so rather than blaming the registry
          patch(row.domain, { available: null, checkFailed: true });
        }
      }
    };

    await Promise.all(Array.from({ length: CHECK_POOL }, worker));
    return free;
  };

  const search = async (q: string, all = false) => {
    const run = ++runId.current;
    setSearching(true);
    setShowingAll(all);
    setOffers(null);

    try {
      const rows = await getSearchTlds(q, all);
      if (runId.current !== run) return;
      setOffers(rows);
      await resolveAvailability(rows, run);
    } catch (error: any) {
      if (runId.current !== run) return;
      setOffers(null);
      toast({
        title: t("Search failed"),
        description: error?.message || t("Could not check that domain."),
        variant: "destructive",
      });
    } finally {
      if (runId.current === run) setSearching(false);
    }
  };

  // whether the last search was already showing every extension
  const [showingAll, setShowingAll] = useState(false);

  /**
   * Ask the AI for names, check them, and keep asking while too few come back
   * free — the model cannot know what is taken, so this loop is what turns its
   * guesses into a list worth showing. Names already seen are excluded so each
   * round is fresh rather than the same ideas again.
   *
   * `append` keeps what is on screen and adds to it, which is what "load more"
   * needs; otherwise the list starts over.
   */
  const runSuggest = async (q: string, context: string, append: boolean) => {
    const run = ++runId.current;
    setSuggesting(true);
    setShowingAll(true);

    if (!append) {
      seen.current = [];
      setOffers([]);
    }

    let free = 0;

    try {
      for (
        let round = 0;
        round < SUGGEST_ROUNDS && free < SUGGEST_TARGET;
        round++
      ) {
        const rows = await suggestDomains(q, context, seen.current);
        if (runId.current !== run) return;
        if (rows.length === 0) break;

        seen.current = [...seen.current, ...rows.map((row) => row.domain)];
        setOffers((prev) => [...(prev ?? []), ...rows]);

        free += await resolveAvailability(rows, run);
        if (runId.current !== run) return;
      }
    } catch (error: any) {
      if (runId.current !== run) return;
      toast({
        title: t("Suggestions unavailable"),
        description: error?.message || t("Could not get domain ideas."),
        variant: "destructive",
      });
    } finally {
      if (runId.current === run) setSuggesting(false);
    }
  };

  const suggest = (q: string, context = "") => runSuggest(q, context, false);
  const suggestMore = (q: string, context = "") =>
    runSuggest(q, context, true);

  const reset = () => {
    runId.current++;
    seen.current = [];
    setOffers(null);
    setSearching(false);
    setSuggesting(false);
    setShowingAll(false);
  };

  return {
    offers,
    searching,
    suggesting,
    showingAll,
    search,
    suggest,
    suggestMore,
    reset,
  };
};

export const useRegisterDomain = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: registerDomain,
    onSuccess: (domain) => {
      queryClient.invalidateQueries({ queryKey: ["domains"] });
      toast({
        title: t("Registration started"),
        description: t(
          "{name} is being registered — follow it in the domains list.",
          { name: domain.name },
        ),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("Registration failed"),
        description: error.message || t("The registrar refused the registration."),
        variant: "destructive",
      });
    },
  });
};

/** One wildcard record instead of one per app. */
export const useSetupWildcard = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: setupWildcard,
    onSuccess: (result, id) => {
      queryClient.invalidateQueries({ queryKey: ["domains"] });
      queryClient.invalidateQueries({ queryKey: ["domains", id, "dns-zone"] });
      toast({ title: t("Wildcard record ready"), description: result.detail });
    },
    onError: (error: Error) => {
      toast({
        title: t("Could not create the wildcard record"),
        description: error.message,
        variant: "destructive",
      });
    },
  });
};
