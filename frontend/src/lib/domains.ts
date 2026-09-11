import apiRequest from "./api";
import { t } from "@/lib/i18n";
import { ListParams, listQuery } from "./admin";
import type { Paginated } from "@/components/DataTable";
import {
  Domain,
  CreateDomainData,
  UpdateDomainData,
  DomainVerificationResult,
} from "@/types/domain";

/**
 * A registration in flight. Set by the backend while it orders the domain and
 * wires up DNS; absent on every domain that is not mid-purchase.
 */
export type Provisioning = {
  state: "QUEUED" | "REGISTERING" | "WIRING" | "DONE" | "FAILED";
  step: string;
  error?: string | null;
  years: number;
};

export const provisioningOf = (domain: Domain): Provisioning | null => {
  const p = domain.customConfig?.provisioning as Provisioning | undefined;
  return p && p.state !== "DONE" ? p : null;
};

/** Still working — worth polling for. */
export const isProvisioning = (domain: Domain) =>
  ["QUEUED", "REGISTERING", "WIRING"].includes(
    provisioningOf(domain)?.state ?? "",
  );

// Get all domains
export const getDomainsPage = async (
  params: ListParams,
): Promise<Paginated<Domain>> => {
  const response = await apiRequest<Paginated<Domain>>(
    `/domains${listQuery(params)}`,
  );

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t("Failed to fetch domains"));
};

export const getDomains = async (): Promise<Domain[]> => {
  const response = await apiRequest<Domain[]>("/domains", {
    method: "GET",
  });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t("Failed to fetch domains"));
};

// Get a specific domain
export const getDomain = async (id: string): Promise<Domain> => {
  const response = await apiRequest<Domain>(`/domains/${id}`, {
    method: "GET",
  });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t("Failed to fetch domain"));
};

export type DomainDnsZone = {
  zone: {
    id: string;
    name: string;
    nameservers: string[];
  } | null;
  records: any[];
  /** what "this platform" resolves to, so records pointing at us can be labelled */
  platformTarget: { type: "A" | "CNAME"; content: string } | null;
  synced: boolean;
};

/** What "this platform" points at, for labelling records in the domains list. */
export const getPlatformTarget = async (): Promise<
  DomainDnsZone["platformTarget"]
> => {
  const response = await apiRequest<DomainDnsZone["platformTarget"]>(
    "/domains/platform-target",
  );
  return response.success ? (response.data ?? null) : null;
};

export const getDomainDnsZone = async (id: string): Promise<DomainDnsZone> => {
  const response = await apiRequest<DomainDnsZone>(`/domains/${id}/dns-zone`, {
    method: "GET",
  });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t("Failed to fetch domain DNS zone"));
};

// Create a new domain
export const createDomain = async (data: CreateDomainData): Promise<Domain> => {
  const response = await apiRequest<Domain>("/domains", {
    method: "POST",
    body: JSON.stringify(data),
  });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t("Failed to create domain"));
};

export type DomainSyncResult = {
  total: number;
  created: number;
  updated: number;
  cfOnly: number;
  rdashOnly: number;
  errors?: Record<string, string>;
};

// Reconcile domains from RDASH (registrar) and Cloudflare (DNS) into our list
export type DomainSyncState = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  result: DomainSyncResult | null;
  error: string | null;
};

// Starts the run and returns straight away — a sync takes minutes.
export const startDomainSync = async (): Promise<DomainSyncState> => {
  const response = await apiRequest<DomainSyncState>("/domains/sync", {
    method: "POST",
  });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t("Failed to start the domain sync"));
};

export const getDomainSyncStatus = async (): Promise<DomainSyncState> => {
  const response = await apiRequest<DomainSyncState>("/domains/sync/status");

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t("Failed to read the sync status"));
};

export const bulkAssignDomains = async (
  ids: string[],
  organizationId: string | null,
): Promise<number> => {
  const response = await apiRequest<{ count: number }>("/domains/bulk-assign", {
    method: "PATCH",
    body: JSON.stringify({ ids, organizationId }),
  });

  if (response.success && response.data) {
    return response.data.count;
  }

  throw new Error(response.error || t("Failed to assign domains"));
};

export type RdashDns = {
  registered: boolean;
  nameservers: string[];
  delegatedToCloudflare?: boolean;
  records: any[];
};

// What the registrar still holds for the domain, before/independently of Cloudflare
export const getRdashDns = async (id: string): Promise<RdashDns> => {
  const response = await apiRequest<RdashDns>(`/domains/${id}/rdash-dns`);

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t("Failed to read DNS from RDASH"));
};

export type CloudflareEnableResult = {
  steps: string[];
  warnings: string[];
  nameserversUpdated: boolean;
  recordsImported: number;
  zone: { id: string; name: string; nameServers: string[] };
};

export const enableCloudflare = async (
  id: string,
): Promise<CloudflareEnableResult> => {
  const response = await apiRequest<CloudflareEnableResult>(
    `/domains/${id}/cloudflare/enable`,
    {
      method: "POST",
    },
  );

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t("Failed to enable Cloudflare"));
};

export const disableCloudflare = async (id: string): Promise<void> => {
  const response = await apiRequest(`/domains/${id}/cloudflare/disable`, {
    method: "POST",
  });

  if (!response.success) {
    throw new Error(response.error || t("Failed to disable Cloudflare"));
  }
};

export type DnsRecordInput = {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
  proxied?: boolean;
};

export const createDnsRecord = async (
  domainId: string,
  record: DnsRecordInput,
): Promise<any> => {
  const response = await apiRequest<any>(`/domains/${domainId}/dns-records`, {
    method: "POST",
    body: JSON.stringify(record),
  });

  if (response.success) return response.data;
  throw new Error(response.error || t("Failed to create the DNS record"));
};

export const updateDnsRecord = async (
  domainId: string,
  recordId: string,
  record: DnsRecordInput,
): Promise<any> => {
  const response = await apiRequest<any>(
    `/domains/${domainId}/dns-records/${recordId}`,
    {
      method: "PUT",
      body: JSON.stringify(record),
    },
  );

  if (response.success) return response.data;
  throw new Error(response.error || t("Failed to update the DNS record"));
};

export const deleteDnsRecord = async (
  domainId: string,
  recordId: string,
): Promise<void> => {
  const response = await apiRequest(
    `/domains/${domainId}/dns-records/${recordId}`,
    {
      method: "DELETE",
    },
  );

  if (!response.success) {
    throw new Error(response.error || t("Failed to delete the DNS record"));
  }
};

export const importRegistrarDns = async (
  domainId: string,
): Promise<{ imported: number; skipped: number; failed: string[] }> => {
  const response = await apiRequest<{
    imported: number;
    skipped: number;
    failed: string[];
  }>(`/domains/${domainId}/dns-records/import`, { method: "POST" });

  if (response.success && response.data) return response.data;
  throw new Error(
    response.error || t("Failed to import the registrar DNS records"),
  );
};

// Update a domain
export const updateDomain = async (
  id: string,
  data: UpdateDomainData,
): Promise<Domain> => {
  const response = await apiRequest<Domain>(`/domains/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t("Failed to update domain"));
};

// Delete a domain
export const deleteDomain = async (id: string): Promise<void> => {
  const response = await apiRequest(`/domains/${id}`, {
    method: "DELETE",
  });

  if (!response.success) {
    throw new Error(response.error || t("Failed to delete domain"));
  }
};

// Verify domain DNS
export const verifyDomain = async (
  id: string,
): Promise<DomainVerificationResult> => {
  const response = await apiRequest<DomainVerificationResult>(
    `/domains/${id}/verify`,
    {
      method: "POST",
    },
  );

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t("Failed to verify domain"));
};

// Renew a domain registration at the registrar (RDASH only)
export const renewDomain = async (id: string, years = 1): Promise<string> => {
  const response = await apiRequest(`/domains/${id}/renew`, {
    method: "POST",
    body: JSON.stringify({ years }),
  });

  if (!response.success) {
    throw new Error(response.error || t("Failed to renew domain"));
  }

  return response.message || t("Renewal submitted.");
};

export type DomainRegistration = {
  domain: string;
  registrar: string | null;
  registrarId: string | null;
  status: string[];
  registeredAt: string | null;
  updatedAt: string | null;
  expiresAt: string | null;
  nameservers: string[];
};

// Registry record (RDAP). null means the TLD publishes nothing we can read.
export const getDomainRegistration = async (
  id: string,
): Promise<DomainRegistration | null> => {
  const response = await apiRequest<DomainRegistration | null>(
    `/domains/${id}/registration`,
  );

  if (!response.success) {
    throw new Error(response.error || t("Failed to look up the registration"));
  }

  return response.data ?? null;
};

/* ---------------- Register a new domain: search, then buy ---------------- */

/** A row in the search results. Price is known up front; availability streams in. */
export type DomainOffer = {
  domain: string;
  tld: string;
  currency: string;
  /**
   * Registration periods the registrar sells, as years -> total price for that
   * whole period. Not a yearly rate: three years is `periods[3]`, which is not
   * always `periods[1] * 3`. Empty when the extension has no price.
   */
  periods: Record<number, number>;
  renewalPeriods: Record<number, number>;
  /** proposed by the AI rather than typed by the user */
  suggested?: boolean;
  /** true = free, false = taken, null = no registry answer, undefined = still checking */
  available?: boolean | null;
  registrar?: string | null;
  owned?: boolean;
  /** the check request itself failed — distinct from the registry not answering */
  checkFailed?: boolean;
};

/**
 * The TLDs on offer and their prices — no registry lookups, returns at once.
 * `all` opens the full catalogue instead of the short list.
 */
export const getSearchTlds = async (
  q: string,
  all = false,
): Promise<DomainOffer[]> => {
  const response = await apiRequest<DomainOffer[]>(
    `/domains/search/tlds?q=${encodeURIComponent(q)}${all ? "&all=1" : ""}`,
  );

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t("Domain search failed"));
};

/**
 * AI-proposed names for a keyword. Same row shape as a search, so they render
 * and get checked through the same path. `context` describes what the site is
 * for, which is what makes the names fit; `exclude` asks for a fresh batch,
 * skipping names already on screen.
 */
export const suggestDomains = async (
  q: string,
  context = "",
  exclude: string[] = [],
): Promise<DomainOffer[]> => {
  const params = new URLSearchParams({ q });
  if (context.trim()) params.set("context", context.trim());
  if (exclude.length > 0) params.set("exclude", exclude.join(","));

  const response = await apiRequest<DomainOffer[]>(
    `/domains/search/suggest?${params.toString()}`,
  );

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t("Could not get suggestions"));
};

export type DomainCheck = {
  domain: string;
  available: boolean | null;
  registrar: string | null;
  owned: boolean;
};

/** Availability of one name. Slow (it asks the registry) — call one per row. */
export const checkDomain = async (domain: string): Promise<DomainCheck> => {
  const response = await apiRequest<DomainCheck>(
    `/domains/search/check?domain=${encodeURIComponent(domain)}`,
  );

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t("Availability check failed"));
};

export const registerDomain = async (data: {
  name: string;
  organizationId: string;
  years: number;
}): Promise<Domain> => {
  const response = await apiRequest<Domain>("/domains/register", {
    method: "POST",
    body: JSON.stringify(data),
  });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t("Failed to register domain"));
};

/**
 * Point `*.domain` at the platform, so apps deployed under it need no DNS
 * record of their own. Domains registered here get this automatically.
 */
export const setupWildcard = async (
  id: string,
): Promise<{ state: string; detail: string }> => {
  const response = await apiRequest<{ state: string; detail: string }>(
    `/domains/${id}/wildcard`,
    { method: "POST" },
  );

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t("Failed to create the wildcard record"));
};
