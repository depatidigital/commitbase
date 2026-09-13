import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import {
  Globe,
  Plus,
  Search,
  AlertCircle,
  CheckCircle,
  XCircle,
  Clock,
  Shield,
  ShieldCheck,
  ShieldX,
  RefreshCw,
  Trash2,
  Edit,
  Eye,
  Loader2,
  ExternalLink,
  Settings,
  ArrowLeft,
  LockOpen,
  Cloud,
  MoreHorizontal,
  Building2,
  RotateCw,
  Unlink,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  useDomainsPage,
  useDomains,
  useDomain,
  useDeleteDomain,
  useVerifyDomain,
  useCreateDomain,
  useDomainDnsZone,
  useSyncDomains,
  useBulkAssignDomains,
  useRdashDns,
  useEnableCloudflare,
  useDisableCloudflare,
  useCreateDnsRecord,
  useUpdateDnsRecord,
  useDeleteDnsRecord,
  useImportRegistrarDns,
  useRenewDomain,
  useDomainRegistration,
  usePlatformTarget,
  useSetupWildcard,
} from "@/hooks/useDomains";
import { provisioningOf } from "@/lib/domains";
import { useQuery } from "@tanstack/react-query";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { OrganizationFilter } from "@/components/OrganizationFilter";
import { OrganizationCombobox } from "@/components/OrganizationCombobox";
import { DomainSharedCard } from "@/components/DomainSharedCard";
import { expiryTone, needsRenewal } from "@/lib/domainExpiry";
import { isAdmin } from "@/lib/auth";
import { Domain } from "@/types/domain";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { APP_NAME } from "@/lib/branding";
import { locale, t } from "@/lib/i18n";

// radix Select rejects an empty string value, so "no organization" needs a sentinel
const UNASSIGNED = "__unassigned__";
const ANY = "__any__";

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: t("active"),
  INACTIVE: t("inactive"),
  PENDING: t("pending"),
  ERROR: t("error"),
};

const SSL_LABELS: Record<string, string> = {
  ACTIVE: t("active"),
  PENDING: t("pending"),
  EXPIRED: t("expired"),
  ERROR: t("error"),
};


// compact form for the table — "25 Sep 2027"
const formatDateShort = (value: Date) =>
  value.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

const formatDate = (value: Date) =>
  value.toLocaleDateString(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

export default function Domains() {
  const navigate = useNavigate();
  const params = useParams();
  const domainId = params.id ?? null;

  const query = useTableQuery();
  const [confirmAction, setConfirmAction] = useState<{
    type: "delete" | "verify" | "renew";
    domainId: string;
    domainName: string;
  } | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [newDomainName, setNewDomainName] = useState("");
  const [newDomainOrgId, setNewDomainOrgId] = useState("");
  // register flow: search the registrar, pick an offer, buy it
  const [listFilter, setListFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState(ANY);
  const [expiryFilter, setExpiryFilter] = useState(ANY);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkOrgId, setBulkOrgId] = useState("");
  const [assignTarget, setAssignTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [assignOrgId, setAssignOrgId] = useState(UNASSIGNED);
  const [cloudflarePrompt, setCloudflarePrompt] = useState<
    "enable" | "disable" | null
  >(null);
  // null = closed, {} = adding, {id} = editing that record
  const [recordForm, setRecordForm] = useState<{
    id?: string;
    name: string;
    /** "auto" points at the platform's own target and picks A vs CNAME for you */
    mode: "auto" | "custom";
    type: string;
    content: string;
    ttl: string;
    proxied: boolean;
  } | null>(null);
  const [recordToDelete, setRecordToDelete] = useState<any | null>(null);
  const { toast } = useToast();

  // API hooks
  const {
    data: domainsData,
    isLoading,
    error,
  } = useDomainsPage({
    ...query.params,
    ...(listFilter !== "all" && { filter: listFilter }),
    ...(statusFilter !== ANY && { status: statusFilter }),
    ...(expiryFilter !== ANY && { expiring: expiryFilter }),
  });
  const {
    data: domainDetail,
    isLoading: domainLoading,
    error: domainError,
  } = useDomain(domainId || "");
  const deleteDomain = useDeleteDomain();
  const verifyDomain = useVerifyDomain();
  const createDomain = useCreateDomain();
  const syncDomains = useSyncDomains();
  const bulkAssign = useBulkAssignDomains();
  const setupWildcard = useSetupWildcard();
  const enableCloudflare = useEnableCloudflare();
  const disableCloudflare = useDisableCloudflare();
  const createDnsRecord = useCreateDnsRecord(domainId || "");
  const updateDnsRecord = useUpdateDnsRecord(domainId || "");
  const deleteDnsRecord = useDeleteDnsRecord(domainId || "");
  const importRegistrarDns = useImportRegistrarDns(domainId || "");
  const renewDomain = useRenewDomain();
  // adding a domain provisions a real Cloudflare zone — admins only
  const admin = isAdmin();
  const {
    data: domainDnsZone,
    isLoading: dnsZoneLoading,
    error: dnsZoneError,
  } = useDomainDnsZone(domainId);
  const { data: registration, isLoading: registrationLoading } =
    useDomainRegistration(domainId);
  const { data: rdashDns, isLoading: rdashDnsLoading } = useRdashDns(
    domainId,
    domainDetail?.registrar === "RDASH",
  );

  const domains = domainsData?.data ?? [];

  // the list has no zone loaded, so it gets the platform target on its own
  const { data: listPlatformTarget } = usePlatformTarget();
  const platformTarget =
    domainDnsZone?.platformTarget?.content ??
    listPlatformTarget?.content ??
    null;

  /** Records pointing at our own server read better as "this platform" than as a bare IP. */
  const isPlatformTarget = (content: unknown) =>
    !!platformTarget && String(content) === platformTarget;

  // hostname records for the zone, apex included — it is shown as "@" like every DNS UI does
  // editing the domain itself: there is no subdomain part to fill in
  const editingApex =
    !!recordForm?.id && (recordForm.name === "" || recordForm.name === "@");

  const wildcardRecord = (domainDnsZone?.records ?? []).find(
    (record: any) => String(record?.name) === `*.${domainDetail?.name}`,
  );

  const subdomainRecords = (domainDnsZone?.records ?? [])
    .filter(
      (record: any) =>
        typeof record?.name === "string" &&
        record.name !== domainDetail?.name &&
        ["A", "AAAA", "CNAME"].includes(String(record?.type).toUpperCase()),
    )
    .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));

  const hostLabel = (name: string) =>
    name === domainDetail?.name
      ? "@"
      : name.replace(`.${domainDetail?.name}`, "");
  const allSelected =
    domains.length > 0 && domains.every((d) => selectedIds.includes(d.id));

  const toggleAll = () =>
    setSelectedIds(allSelected ? [] : domains.map((d) => d.id));

  const toggleOne = (id: string) =>
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const domainColumns: Column<(typeof domains)[number]>[] = [
    ...(admin
      ? [
          {
            header: (
              <Checkbox
                checked={allSelected}
                onCheckedChange={toggleAll}
                aria-label={t("Select all domains on this page")}
              />
            ),
            className: "w-10",
            cell: (domain: Domain) => (
              <Checkbox
                checked={selectedIds.includes(domain.id)}
                onCheckedChange={() => toggleOne(domain.id)}
                aria-label={t("Select {name}", { name: domain.name })}
              />
            ),
          },
        ]
      : []),
    {
      header: t("Domain"),
      sortKey: "name",
      className: "w-[26%]",
      cell: (domain) => {
        const secure = domain.sslStatus === "ACTIVE";
        const Icon = secure ? Globe : LockOpen;
        const sslLabel = secure
          ? t("HTTPS active — valid certificate served")
          : domain.sslStatus === "PENDING"
            ? t("HTTPS pending — certificate not issued yet")
            : domain.sslStatus === "EXPIRED"
              ? t("HTTPS expired — the certificate has lapsed")
              : domain.sslStatus === "ERROR"
                ? t("HTTPS broken — the certificate is not trusted for this domain")
                : t("No HTTPS — nothing answered on port 443");
        return (
          <div className="flex min-w-0 items-center space-x-2 font-medium">
            <Icon
              className={`h-4 w-4 shrink-0 ${
                secure ? "text-success" : "text-warning"
              }`}
              aria-label={sslLabel}
            >
              <title>{sslLabel}</title>
            </Icon>
            <button
              type="button"
              onClick={() => navigate(`/domains/${domain.id}`)}
              className="truncate hover:underline"
            >
              {domain.name}
            </button>
            {domain.registrar === "EXTERNAL" && (
              <Badge
                variant="outline"
                className="gap-1 border-border/60 bg-transparent px-1.5 py-0 text-[11px] font-normal text-muted-foreground"
              >
                <Unlink className="h-3 w-3" />
                {t("External")}
              </Badge>
            )}
            {!domain.cfZoneId && (
              <Badge variant="outline" className="border-warning text-warning">
                {t("No zone")}
              </Badge>
            )}
          </div>
        );
      },
    },
    {
      // where it points is each app's business now — the list says how many live here
      header: t("Apps"),
      className: "w-20",
      cell: (domain) => {
        const apps = domain._count?.applications ?? 0;
        return apps ? <span>{apps}</span> : <span className="text-muted-foreground">-</span>;
      },
    },
    {
      header: t("Organization"),
      className: "w-[24%]",
      cell: (domain) =>
        domain.organization ? (
          <Badge variant="outline" className="max-w-full truncate">
            {domain.organization.name}
          </Badge>
        ) : (
          <span className="text-muted-foreground">{t("Unassigned")}</span>
        ),
    },
    {
      header: t("Status"),
      className: "w-28",
      cell: (domain) => {
        // a registration still running says more than the PENDING row behind it
        const provisioning = provisioningOf(domain);
        if (provisioning) {
          return provisioning.state === "FAILED" ? (
            <Badge variant="destructive" className="gap-1" title={provisioning.error ?? ""}>
              <AlertCircle className="h-3.5 w-3.5" />
              {t("failed")}
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1" title={provisioning.step}>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("registering")}
            </Badge>
          );
        }
        return getStatusBadge(domain.status, domain.expiresAt);
      },
    },
    {
      header: t("Expires"),
      sortKey: "expiresAt",
      className: "w-48 text-xs",
      cell: (domain) => {
        if (!domain.expiresAt) {
          return <span className="text-muted-foreground">-</span>;
        }
        const expiry = new Date(domain.expiresAt);
        const tone = expiryTone(expiry);
        return (
          <span className={tone.className}>
            {tone.urgent && (
              <AlertCircle className="mr-1 inline h-3.5 w-3.5 align-text-bottom" />
            )}
            {formatDateShort(expiry)}
            {tone.note && <span className="ml-1 text-xs">({tone.note})</span>}
            {admin && needsRenewal(domain) && (
              <Button
                variant="outline"
                size="sm"
                className="ml-2 h-6 px-2 text-xs"
                onClick={() => handleRenew(domain)}
                disabled={renewDomain.isPending}
              >
                <RotateCw className="h-3 w-3 mr-1" />
                {t("Renew")}
              </Button>
            )}
          </span>
        );
      },
    },
    {
      header: t("Actions"),
      className: "w-16",
      cell: (domain) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              aria-label={t("Actions for {name}", { name: domain.name })}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => navigate(`/domains/${domain.id}`)}>
              <Eye className="mr-2 h-4 w-4" />
              {t("Manage")}
            </DropdownMenuItem>
            {admin && (
              <DropdownMenuItem
                onClick={() => {
                  setAssignTarget({ id: domain.id, name: domain.name });
                  setAssignOrgId(domain.organization?.id ?? UNASSIGNED);
                }}
              >
                <Building2 className="mr-2 h-4 w-4" />
                {t("Assign organization")}
              </DropdownMenuItem>
            )}
            {admin && needsRenewal(domain) && (
              <DropdownMenuItem
                onClick={() => handleRenew(domain)}
                disabled={renewDomain.isPending}
              >
                <RotateCw className="mr-2 h-4 w-4" />
                {t("Renew registration")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => handleVerify(domain.id, domain.name)}
              disabled={verifyDomain.isPending}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {t("Verify DNS")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => handleDelete(domain.id, domain.name)}
              disabled={deleteDomain.isPending}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t("Delete domain")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  if (domainId) {
    if (domainError) {
      return (
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">{t("Error Loading Domain")}</h3>
            <p className="text-muted-foreground mb-4">
              {t("Failed to load domain. Please try again.")}
            </p>
            <Button variant="outline" onClick={() => navigate("/domains")}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              {t("Back to domains")}
            </Button>
          </div>
        </div>
      );
    }

    if (domainLoading || !domainDetail) {
      return (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      );
    }
  }

  const handleDelete = async (id: string, name: string) => {
    setConfirmAction({ type: "delete", domainId: id, domainName: name });
  };

  const handleVerify = async (id: string, name: string) => {
    setConfirmAction({ type: "verify", domainId: id, domainName: name });
  };

  const handleRenew = (domain: Pick<Domain, "id" | "name" | "registrar">) => {
    // external domains live at a registrar we do not talk to — say so instead of failing
    if (domain.registrar !== "RDASH") {
      toast({
        title: t("External domain"),
        description: t(
          "{name} is registered outside {app}. Renew it with the registrar you bought it from.",
          { name: domain.name, app: APP_NAME },
        ),
      });
      return;
    }
    setConfirmAction({
      type: "renew",
      domainId: domain.id,
      domainName: domain.name,
    });
  };

  const resetAddDialog = () => {
    setAddDialogOpen(false);
    setNewDomainName("");
    setNewDomainOrgId("");
  };

  // "Use existing domain" — we already own it, just connect it
  const handleAddDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = newDomainName.trim();
    if (!value || !newDomainOrgId) {
      return;
    }

    try {
      await createDomain.mutateAsync({
        name: value,
        organizationId: newDomainOrgId,
        customConfig: { mode: "existing" },
      });

      resetAddDialog();
    } catch {}
  };

  const executeAction = async () => {
    if (!confirmAction) return;

    try {
      switch (confirmAction.type) {
        case "delete":
          await deleteDomain.mutateAsync(confirmAction.domainId);
          break;
        case "verify":
          await verifyDomain.mutateAsync(confirmAction.domainId);
          break;
        case "renew":
          await renewDomain.mutateAsync({ id: confirmAction.domainId });
          break;
      }
    } catch (error) {
      // Error is handled by the mutation
    } finally {
      setConfirmAction(null);
    }
  };

  const getDialogContent = () => {
    if (!confirmAction) return null;

    const { type, domainName } = confirmAction;

    switch (type) {
      case "delete":
        return {
          title: t("Delete Domain"),
          description: t(
            'Are you sure you want to delete "{name}"? This action cannot be undone and will remove all associated DNS records and SSL certificates.',
            { name: domainName },
          ),
          actionText: t("Delete Domain"),
          variant: "destructive" as const,
        };
      case "verify":
        return {
          title: t("Verify Domain DNS"),
          description: t(
            'Are you sure you want to verify the DNS records for "{name}"? This will check if the domain is properly configured.',
            { name: domainName },
          ),
          actionText: t("Verify DNS"),
          variant: "default" as const,
        };
      case "renew":
        return {
          title: t("Renew Domain"),
          description: t(
            'Renew "{name}" for 1 year at the registrar? This charges your registrar account and cannot be undone.',
            { name: domainName },
          ),
          actionText: t("Renew for 1 year"),
          variant: "default" as const,
        };
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "ACTIVE":
        return <CheckCircle className="h-3.5 w-3.5" />;
      case "INACTIVE":
        return <XCircle className="h-3.5 w-3.5" />;
      case "PENDING":
        return <Clock className="h-3.5 w-3.5" />;
      case "ERROR":
        return <AlertCircle className="h-3.5 w-3.5" />;
      default:
        return <Clock className="h-3.5 w-3.5" />;
    }
  };

  const getSSLIcon = (sslStatus: string) => {
    switch (sslStatus) {
      case "ACTIVE":
        return <ShieldCheck className="h-3.5 w-3.5" />;
      case "PENDING":
        return <Shield className="h-3.5 w-3.5" />;
      case "EXPIRED":
        return <ShieldX className="h-3.5 w-3.5" />;
      case "ERROR":
        return <ShieldX className="h-3.5 w-3.5" />;
      default:
        return <Shield className="h-3.5 w-3.5" />;
    }
  };

  /**
   * Registration status. An ACTIVE domain about to lapse is its own state —
   * "active" hides the one thing an admin has to act on.
   */
  const getStatusBadge = (status: string, expiresAt?: string | Date | null) => {
    const variants = {
      ACTIVE: "default",
      INACTIVE: "secondary",
      PENDING: "outline",
      ERROR: "destructive",
    } as const;

    if (status === "ACTIVE" && expiresAt) {
      const daysLeft = Math.ceil(
        (new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
      );

      if (daysLeft < 0) {
        return (
          <Badge variant="destructive" className="gap-1">
            <AlertCircle className="h-3.5 w-3.5" />
            {t("expired")}
          </Badge>
        );
      }

      if (daysLeft <= 30) {
        return (
          <Badge
            variant="outline"
            className="gap-1 border-warning bg-warning/10 text-warning"
          >
            <Clock className="h-3.5 w-3.5" />
            {t("expiring")}
          </Badge>
        );
      }
    }

    return (
      <Badge
        variant={variants[status as keyof typeof variants] || "secondary"}
        // active is a healthy state, not a branded one
        className={`gap-1 ${
          status === "ACTIVE"
            ? "bg-success text-success-foreground hover:bg-success/90"
            : ""
        }`}
      >
        {getStatusIcon(status)}
        {STATUS_LABELS[status] ?? status.toLowerCase()}
      </Badge>
    );
  };

  const getSSLBadge = (sslStatus: string) => {
    const variants = {
      ACTIVE: "default",
      PENDING: "outline",
      EXPIRED: "destructive",
      ERROR: "destructive",
    } as const;

    return (
      <Badge
        variant={variants[sslStatus as keyof typeof variants] || "secondary"}
        className={`gap-1 ${
          sslStatus === "ACTIVE"
            ? "bg-success text-success-foreground hover:bg-success/90"
            : ""
        }`}
      >
        {getSSLIcon(sslStatus)}
        {SSL_LABELS[sslStatus] ?? sslStatus.toLowerCase()}
      </Badge>
    );
  };

  if (!domainId) {
    if (isLoading) {
      return (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">
              {t("Error Loading Domains")}
            </h3>
            <p className="text-muted-foreground">
              {t("Failed to load domains. Please try again.")}
            </p>
          </div>
        </div>
      );
    }
  }

  const dialogContent = getDialogContent();

  return (
    <TooltipProvider>
      <div className="space-y-8 animate-fade-in">
        {domainId && domainDetail ? (
          <>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={t("Back to domains")}
                  onClick={() => navigate("/domains")}
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                <div>
                  <div className="flex items-center gap-2">
                    <h1 className="text-xl font-semibold">
                      {domainDetail.name}
                    </h1>
                    {domainDetail.expiresAt &&
                      (() => {
                        const tone = expiryTone(
                          new Date(domainDetail.expiresAt),
                        );
                        if (!tone.urgent) return null;
                        return (
                          <Badge
                            variant={tone.days <= 7 ? "destructive" : "outline"}
                            className={
                              tone.days <= 7
                                ? "gap-1"
                                : "gap-1 border-warning text-warning"
                            }
                          >
                            <AlertCircle className="h-3.5 w-3.5" />
                            {tone.days < 0
                              ? t("Registration expired")
                              : // the note already says it ("expires today", "5d left")
                                tone.note.charAt(0).toUpperCase() + tone.note.slice(1)}
                          </Badge>
                        );
                      })()}
                    {getStatusBadge(
                      domainDetail.status,
                      domainDetail.expiresAt,
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t("Domain DNS zone and SSL configuration.")}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {admin && needsRenewal(domainDetail) && (
                  <Button
                    size="sm"
                    onClick={() => handleRenew(domainDetail)}
                    disabled={renewDomain.isPending}
                  >
                    <RotateCw className="h-4 w-4 mr-2" />
                    {t("Renew")}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    handleVerify(domainDetail.id, domainDetail.name)
                  }
                  disabled={verifyDomain.isPending}
                >
                  {verifyDomain.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      {t("Verifying")}
                    </>
                  ) : (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2" />
                      {t("Verify DNS")}
                    </>
                  )}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() =>
                    handleDelete(domainDetail.id, domainDetail.name)
                  }
                  disabled={deleteDomain.isPending}
                >
                  {deleteDomain.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      {t("Deleting")}
                    </>
                  ) : (
                    <>
                      <Trash2 className="h-4 w-4 mr-2" />
                      {t("Delete")}
                    </>
                  )}
                </Button>
              </div>
            </div>

            <Tabs defaultValue="overview" className="space-y-4">
              <TabsList>
                <TabsTrigger value="overview">{t("Overview")}</TabsTrigger>
                <TabsTrigger value="subdomains">{t("Subdomains")}</TabsTrigger>
                <TabsTrigger value="dns">DNS</TabsTrigger>
                <TabsTrigger value="registration">{t("Registration")}</TabsTrigger>
                {admin && <TabsTrigger value="settings">{t("Settings")}</TabsTrigger>}
              </TabsList>

              <TabsContent value="overview" className="space-y-4">
                <div className="grid gap-4 lg:grid-cols-2">
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">{t("Overview")}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 pt-0">
                      {/* what it is doing now */}
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">{t("Status")}</span>
                        {getStatusBadge(
                          domainDetail.status,
                          domainDetail.expiresAt,
                        )}
                      </div>

                      {/* one record that answers for every app under this domain */}
                      {admin && domainDetail.cfZoneId && (
                        <div className="flex items-center justify-between gap-2 text-sm">
                          <span className="text-muted-foreground">
                            {t("Apps subdomain")}
                          </span>
                          {wildcardRecord ? (
                            <Badge variant="secondary">*.{domainDetail.name}</Badge>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7"
                              disabled={setupWildcard.isPending}
                              onClick={() => setupWildcard.mutate(domainDetail.id)}
                              title={t("Points *.domain at the platform, so apps deployed under it need no record of their own")}
                            >
                              {t("Point all subdomains here")}
                            </Button>
                          )}
                        </div>
                      )}

                      {/* who runs its DNS and certificate */}
                      <div className="flex items-center justify-between gap-2 border-t pt-2 text-sm">
                        <span className="text-muted-foreground">DNS</span>
                        {domainDetail.cfZoneId ? (
                          <Badge variant="secondary">Cloudflare</Badge>
                        ) : admin ? (
                          <Button
                            size="sm"
                            className="h-7"
                            onClick={() => setCloudflarePrompt("enable")}
                            disabled={enableCloudflare.isPending}
                          >
                            {enableCloudflare.isPending && (
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            )}
                            {t("Move to Cloudflare")}
                          </Button>
                        ) : (
                          <Badge
                            variant="outline"
                            className="border-warning text-warning"
                          >
                            {t("Not on Cloudflare")}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">SSL</span>
                        <span className="flex items-center gap-2">
                          {getSSLBadge(domainDetail.sslStatus)}
                          {domainDetail.sslExpiry && (
                            <span className="text-xs text-muted-foreground">
                              {t("until {date}", {
                                date: formatDate(new Date(domainDetail.sslExpiry)),
                              })}
                            </span>
                          )}
                        </span>
                      </div>

                      {/* who owns it and for how long */}
                      <div className="flex items-center justify-between gap-2 border-t pt-2 text-sm">
                        <span className="text-muted-foreground">{t("Registrar")}</span>
                        <span>
                          {domainDetail.registrar === "RDASH"
                            ? t("Managed")
                            : domainDetail.registrar === "EXTERNAL"
                              ? t("External")
                              : t("Unknown")}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">
                          {t("Registration expiry")}
                        </span>
                        {domainDetail.expiresAt ? (
                          (() => {
                            const expiry = new Date(domainDetail.expiresAt);
                            const tone = expiryTone(expiry);
                            return (
                              <span className={tone.className}>
                                {tone.urgent && (
                                  <AlertCircle className="mr-1 inline h-3.5 w-3.5 align-text-bottom" />
                                )}
                                {formatDate(expiry)}
                                {tone.note && (
                                  <span className="ml-1 text-xs">
                                    ({tone.note})
                                  </span>
                                )}
                              </span>
                            );
                          })()
                        ) : (
                          <span>-</span>
                        )}
                      </div>
                      {(() => {
                        const target =
                          domainDetail.customConfig?.cloudflare?.target;
                        const value =
                          domainDetail.redirectTo || target?.content;
                        if (!value) return null;

                        return (
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">
                              {domainDetail.redirectTo
                                ? t("Redirect to")
                                : t("Destination")}
                            </span>
                            <span className="flex items-center gap-2 text-muted-foreground">
                              <ExternalLink className="h-3 w-3" />
                              {value}
                              {!domainDetail.redirectTo && target?.type && (
                                <span className="text-xs">({target.type})</span>
                              )}
                            </span>
                          </div>
                        );
                      })()}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                      <CardTitle className="text-base">{t("Subdomains")}</CardTitle>
                      {domainDetail.cfZoneId && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setRecordForm({
                              name: "",
                              mode: "auto",
                              type: "CNAME",
                              content: "",
                              ttl: "1",
                              proxied: true,
                            })
                          }
                        >
                          <Plus className="h-4 w-4 mr-2" />
                          {t("Add")}
                        </Button>
                      )}
                    </CardHeader>
                    <CardContent>
                      {!domainDetail.cfZoneId ? (
                        <p className="text-sm text-muted-foreground">
                          {t("Move this domain to Cloudflare to manage subdomains.")}
                        </p>
                      ) : subdomainRecords.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          {t("None yet.")}
                        </p>
                      ) : (
                        <div className="space-y-1">
                          {subdomainRecords.slice(0, 5).map((record: any) => (
                            <div
                              key={record.id}
                              className="flex items-center justify-between gap-2 text-sm"
                            >
                              <span className="font-mono text-xs">
                                {hostLabel(record.name)}
                              </span>
                              <span className="truncate font-mono text-xs text-muted-foreground">
                                {isPlatformTarget(record.content) ? (
                                  <Badge className="gap-1">
                                    <Cloud className="h-3.5 w-3.5" />
                                    {t("This platform")}
                                  </Badge>
                                ) : (
                                  <>
                                    {record.type} → {record.content}
                                  </>
                                )}
                              </span>
                            </div>
                          ))}
                          {subdomainRecords.length > 5 && (
                            <p className="pt-1 text-xs text-muted-foreground">
                              {t("+{count} more in the Subdomains tab", {
                                count: subdomainRecords.length - 5,
                              })}
                            </p>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>

              <TabsContent value="subdomains" className="space-y-4">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                    <CardTitle className="text-base">{t("Subdomains")}</CardTitle>
                    {domainDetail.cfZoneId && (
                      <Button
                        size="sm"
                        onClick={() =>
                          setRecordForm({
                            name: "",
                            mode: "auto",
                            type: "CNAME",
                            content: "",
                            ttl: "1",
                            proxied: true,
                          })
                        }
                      >
                        <Plus className="h-4 w-4 mr-2" />
                        {t("Add subdomain")}
                      </Button>
                    )}
                  </CardHeader>
                  <CardContent>
                    {!domainDetail.cfZoneId ? (
                      <p className="text-sm text-warning">
                        {t("Move this domain to Cloudflare before managing subdomains.")}
                      </p>
                    ) : dnsZoneLoading ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>{t("Loading subdomains…")}</span>
                      </div>
                    ) : subdomainRecords.length === 0 ? (
                      <div className="space-y-3">
                        <p className="text-sm text-muted-foreground">
                          {t(
                            "No hostname records yet. Add one, or pull across whatever the registrar was serving.",
                          )}
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => importRegistrarDns.mutate()}
                          disabled={importRegistrarDns.isPending}
                        >
                          {importRegistrarDns.isPending ? (
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          ) : (
                            <RefreshCw className="h-4 w-4 mr-2" />
                          )}
                          {t("Sync from registrar DNS")}
                        </Button>
                      </div>
                    ) : (
                      <div className="rounded-md border overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>{t("Subdomain")}</TableHead>
                              <TableHead>{t("Type")}</TableHead>
                              <TableHead>{t("Target")}</TableHead>
                              <TableHead>{t("Proxied")}</TableHead>
                              <TableHead className="text-right">TTL</TableHead>
                              <TableHead className="w-12" />
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {subdomainRecords.map((record: any) => (
                              <TableRow key={record.id}>
                                <TableCell className="font-mono text-xs">
                                  {hostLabel(record.name)}
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                  {record.type}
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                  {isPlatformTarget(record.content) ? (
                                    <Badge className="gap-1">
                                      <Cloud className="h-3.5 w-3.5" />
                                      {t("This platform")}
                                    </Badge>
                                  ) : (
                                    record.content
                                  )}
                                </TableCell>
                                <TableCell>
                                  {record.proxied ? (
                                    <Badge variant="secondary">{t("Proxied")}</Badge>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">
                                      {t("DNS only")}
                                    </span>
                                  )}
                                </TableCell>
                                <TableCell className="text-right text-xs">
                                  {record.ttl === 1 ? t("Auto") : record.ttl}
                                </TableCell>
                                <TableCell>
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 w-8 p-0"
                                        aria-label={t("Actions for {name}", { name: record.name })}
                                      >
                                        <MoreHorizontal className="h-4 w-4" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      <DropdownMenuItem
                                        onClick={() =>
                                          setRecordForm({
                                            id: record.id,
                                            mode: "custom",
                                            name:
                                              record.name === domainDetail.name
                                                ? ""
                                                : hostLabel(record.name),
                                            type: record.type,
                                            content: record.content,
                                            ttl: String(record.ttl ?? 1),
                                            proxied: !!record.proxied,
                                          })
                                        }
                                      >
                                        <Edit className="mr-2 h-4 w-4" />
                                        {t("Edit")}
                                      </DropdownMenuItem>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem
                                        className="text-destructive focus:text-destructive"
                                        onClick={() =>
                                          setRecordToDelete(record)
                                        }
                                      >
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        {t("Delete")}
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="dns" className="space-y-4">
                <div
                  className={
                    domainDetail.registrar === "RDASH"
                      ? "grid gap-4 lg:grid-cols-2"
                      : "grid gap-4"
                  }
                >
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">{t("DNS Records")}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      {dnsZoneLoading ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span>{t("Loading DNS records...")}</span>
                        </div>
                      ) : domainDnsZone && domainDnsZone.records.length > 0 ? (
                        <div className="rounded-md border border-border/60 bg-muted/20 max-h-96 overflow-auto">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-[80px]">{t("Type")}</TableHead>
                                <TableHead>{t("Name")}</TableHead>
                                <TableHead>{t("Content")}</TableHead>
                                <TableHead className="w-[80px] text-right">
                                  TTL
                                </TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {domainDnsZone.records.map((record: any) => (
                                <TableRow key={record.id}>
                                  <TableCell className="font-mono text-xs">
                                    {record.type}
                                  </TableCell>
                                  <TableCell className="font-mono text-xs">
                                    {record.name}
                                  </TableCell>
                                  <TableCell className="font-mono text-xs">
                                    {record.content}
                                  </TableCell>
                                  <TableCell className="text-right text-xs">
                                    {record.ttl}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {t("No DNS records found in Cloudflare for this domain.")}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                  {domainDetail.registrar === "RDASH" && (
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base">
                          {t("Registrar DNS")}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3 pt-0">
                        {rdashDnsLoading ? (
                          <div className="flex items-center text-sm text-muted-foreground">
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />{" "}
                            {t("Reading DNS from the registrar…")}
                          </div>
                        ) : !rdashDns?.registered ? (
                          <p className="text-sm text-muted-foreground">
                            {t("This domain was not found at the registrar.")}
                          </p>
                        ) : (
                          <>
                            <div className="text-sm">
                              <span className="text-muted-foreground">
                                {t("Nameservers:")}{" "}
                              </span>
                              <span className="font-mono text-xs">
                                {rdashDns.nameservers.join(", ") || "-"}
                              </span>
                              {rdashDns.delegatedToCloudflare && (
                                <Badge variant="secondary" className="ml-2">
                                  {t("Delegated to Cloudflare")}
                                </Badge>
                              )}
                            </div>
                            {rdashDns.records.length === 0 ? (
                              <p className="text-sm text-muted-foreground">
                                {t("The registrar holds no DNS records for this domain.")}
                              </p>
                            ) : (
                              <div className="rounded-md border overflow-x-auto">
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>{t("Type")}</TableHead>
                                      <TableHead>{t("Name")}</TableHead>
                                      <TableHead>{t("Content")}</TableHead>
                                      <TableHead className="text-right">
                                        TTL
                                      </TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {rdashDns.records.map(
                                      (record: any, i: number) => (
                                        <TableRow key={record.id ?? i}>
                                          <TableCell className="font-mono text-xs">
                                            {record.type ??
                                              record.record_type ??
                                              "-"}
                                          </TableCell>
                                          <TableCell className="font-mono text-xs">
                                            {record.name ?? record.host ?? "@"}
                                          </TableCell>
                                          <TableCell className="font-mono text-xs">
                                            {record.content ??
                                              record.value ??
                                              record.data ??
                                              "-"}
                                          </TableCell>
                                          <TableCell className="text-right text-xs">
                                            {record.ttl ?? "-"}
                                          </TableCell>
                                        </TableRow>
                                      ),
                                    )}
                                  </TableBody>
                                </Table>
                              </div>
                            )}
                          </>
                        )}
                      </CardContent>
                    </Card>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="registration" className="space-y-4">
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">{t("Registration")}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {registrationLoading ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>{t("Looking up the registry record…")}</span>
                      </div>
                    ) : !registration ? (
                      <p className="text-sm text-muted-foreground">
                        {t(
                          "This TLD publishes no public registry record, or the domain is not registered.",
                        )}
                      </p>
                    ) : (
                      <>
                        <div className="flex items-center justify-between gap-4 text-sm">
                          <span className="text-muted-foreground">
                            {t("Registered with")}
                          </span>
                          <span className="text-right">
                            {registration.registrar ?? t("Unknown")}
                            {registration.registrarId && (
                              <span className="ml-1 text-xs text-muted-foreground">
                                (IANA {registration.registrarId})
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">
                            {t("Registered on")}
                          </span>
                          <span>
                            {registration.registeredAt
                              ? formatDate(new Date(registration.registeredAt))
                              : "-"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">
                            {t("Last changed")}
                          </span>
                          <span>
                            {registration.updatedAt
                              ? formatDate(new Date(registration.updatedAt))
                              : "-"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">{t("Expires")}</span>
                          <span>
                            {registration.expiresAt
                              ? formatDate(new Date(registration.expiresAt))
                              : "-"}
                          </span>
                        </div>
                        {registration.status.length > 0 && (
                          <div className="space-y-1 text-sm">
                            <span className="text-muted-foreground">
                              {t("Registry status")}
                            </span>
                            <div className="flex flex-wrap gap-2">
                              {registration.status.map((state) => (
                                <Badge key={state} variant="secondary">
                                  {state}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        {registration.nameservers.length > 0 && (
                          <div className="space-y-1 text-sm">
                            <span className="text-muted-foreground">
                              {t("Nameservers at the registry")}
                            </span>
                            <div className="flex flex-wrap gap-2">
                              {registration.nameservers.map((ns) => (
                                <Badge key={ns} variant="outline">
                                  {ns}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="settings" className="space-y-4">
                <DomainSharedCard domain={domainDetail} />
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Cloudflare</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 pt-0">
                    {domainDetail.cfZoneId ? (
                      <>
                        <p className="text-sm text-muted-foreground">
                          {t("DNS for this domain is managed in Cloudflare zone")}{" "}
                          <span className="font-mono text-xs">
                            {domainDetail.cfZoneId}
                          </span>
                          .{" "}
                          {t(
                            "Detaching only stops {app} managing it — the zone stays in Cloudflare and the nameservers keep pointing there until you change them at the registrar.",
                            { app: APP_NAME },
                          )}
                        </p>
                        <Button
                          variant="outline"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setCloudflarePrompt("disable")}
                          disabled={disableCloudflare.isPending}
                        >
                          {disableCloudflare.isPending && (
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          )}
                          {t("Detach from Cloudflare")}
                        </Button>
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {t("This domain is not attached to Cloudflare.")}
                      </p>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </>
        ) : (
          <>
            <PageLayout
              icon={Globe}
              title={t("Domains")}
              description={t("Manage your custom domains and SSL certificates.")}
              actions={
                admin ? (
                  <div className="flex items-center gap-3">
                    <Button
                      variant="outline"
                      onClick={() => syncDomains.mutate()}
                      disabled={syncDomains.isPending}
                    >
                      {syncDomains.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4 mr-2" />
                      )}
                      {syncDomains.isPending ? t("Syncing…") : t("Sync domains")}
                    </Button>
                    <Dialog
                      open={addDialogOpen}
                      onOpenChange={(open) =>
                        open ? setAddDialogOpen(true) : resetAddDialog()
                      }
                    >
                      <Button
                        className="bg-gradient-primary shadow-glow hover:shadow-elegant transition-all duration-300"
                        onClick={() => setAddDialogOpen(true)}
                      >
                        <Plus className="h-4 w-4 mr-2" />
                        {t("Connect domain")}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => navigate("/domains/register")}
                      >
                        <Globe className="h-4 w-4 mr-2" />
                        {t("Register domain")}
                      </Button>
                      <DialogContent className="max-w-lg">
                        <DialogHeader>
                          <DialogTitle>{t("Connect a domain")}</DialogTitle>
                          <DialogDescription>
                            {t(
                              "Connect a domain you already own. To buy a new one, use Register domain.",
                            )}
                          </DialogDescription>
                        </DialogHeader>
                        <form onSubmit={handleAddDomain} className="space-y-6">
                          <div className="space-y-2">
                            <Label className="text-sm">
                              {t("Owning organization")}
                            </Label>
                            <OrganizationCombobox
                              value={newDomainOrgId || null}
                              onChange={(id) => setNewDomainOrgId(id ?? "")}
                            />
                            <p className="text-xs text-muted-foreground">
                              {t(
                                "Only this organization's members can create applications on it.",
                              )}
                            </p>
                          </div>
                          {!newDomainOrgId ? (
                            <>
                              <p className="rounded-md border border-dashed border-border/60 p-4 text-sm text-muted-foreground">
                                {t("Choose the owning organization to continue.")}
                              </p>
                              <div className="flex items-center justify-end pt-2">
                                <Button
                                  type="button"
                                  variant="outline"
                                  onClick={resetAddDialog}
                                >
                                  {t("Cancel")}
                                </Button>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="space-y-2">
                                <Label htmlFor="new-domain-name">
                                  {t("Domain name")}
                                </Label>
                                <Input
                                  id="new-domain-name"
                                  placeholder="example.com"
                                  value={newDomainName}
                                  onChange={(e) =>
                                    setNewDomainName(e.target.value)
                                  }
                                />
                              </div>

                              <div className="flex items-center justify-end space-x-3 pt-2">
                                <Button
                                  type="button"
                                  variant="outline"
                                  onClick={resetAddDialog}
                                >
                                  {t("Cancel")}
                                </Button>
                                <Button
                                  type="submit"
                                  className="bg-gradient-primary"
                                  disabled={
                                    createDomain.isPending ||
                                    !newDomainName.trim() ||
                                    !newDomainOrgId
                                  }
                                >
                                  {createDomain.isPending && (
                                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                  )}
                                  {t("Save domain")}
                                </Button>
                              </div>
                            </>
                          )}
                        </form>
                      </DialogContent>
                    </Dialog>
                  </div>
                ) : null
              }
            >
              <div className="flex flex-wrap items-center gap-3">
                <Tabs
                  value={listFilter}
                  onValueChange={(value) => {
                    setListFilter(value);
                    query.setPage(1);
                  }}
                >
                  <TabsList>
                    <TabsTrigger value="all">{t("All")}</TabsTrigger>
                    <TabsTrigger value="unassigned">{t("Unassigned")}</TabsTrigger>
                  </TabsList>
                </Tabs>

                <OrganizationFilter query={query} />

                <Select
                  value={statusFilter}
                  onValueChange={(value) => {
                    setStatusFilter(value);
                    query.setPage(1);
                  }}
                >
                  <SelectTrigger className="w-44">
                    <SelectValue placeholder={t("Any status")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>{t("Any status")}</SelectItem>
                    <SelectItem value="ACTIVE">{t("Active")}</SelectItem>
                    <SelectItem value="PENDING">{t("Pending")}</SelectItem>
                    <SelectItem value="INACTIVE">{t("Inactive")}</SelectItem>
                    <SelectItem value="ERROR">{t("Error")}</SelectItem>
                  </SelectContent>
                </Select>

                <Select
                  value={expiryFilter}
                  onValueChange={(value) => {
                    setExpiryFilter(value);
                    query.setPage(1);
                  }}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue placeholder={t("Any expiration")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>{t("Any expiration")}</SelectItem>
                    <SelectItem value="expired">{t("Expired")}</SelectItem>
                    <SelectItem value="30">{t("Expiring in {days} days", { days: 30 })}</SelectItem>
                    <SelectItem value="60">{t("Expiring in {days} days", { days: 60 })}</SelectItem>
                    <SelectItem value="90">{t("Expiring in {days} days", { days: 90 })}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {admin && selectedIds.length > 0 && (
                <div className="flex flex-wrap items-center gap-3 rounded-md border border-border/60 bg-muted/40 p-3">
                  <span className="text-sm font-medium">
                    {t("{count} selected", { count: selectedIds.length })}
                  </span>
                  <OrganizationCombobox
                    value={bulkOrgId || null}
                    onChange={(id) => setBulkOrgId(id ?? "")}
                    placeholder={t("Assign to organization")}
                    className="w-64"
                  />
                  <Button
                    size="sm"
                    disabled={!bulkOrgId || bulkAssign.isPending}
                    onClick={async () => {
                      await bulkAssign.mutateAsync({
                        ids: selectedIds,
                        organizationId: bulkOrgId,
                      });
                      setSelectedIds([]);
                      setBulkOrgId("");
                    }}
                  >
                    {bulkAssign.isPending && (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    )}
                    {t("Assign")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelectedIds([])}
                  >
                    {t("Clear")}
                  </Button>
                </div>
              )}

              <DataTable
                columns={domainColumns}
                rows={domains}
                rowKey={(domain) => domain.id}
                query={query}
                pagination={domainsData?.pagination}
                isLoading={isLoading}
                searchPlaceholder={t("Search domains…")}
                empty={
                  admin
                    ? t("No domains yet — add your first custom domain.")
                    : t("No domains are assigned to your organization yet. Ask an administrator to assign one.")
                }
              />
            </PageLayout>
          </>
        )}

        {domainDetail && recordForm && (
          <Dialog
            open={!!recordForm}
            onOpenChange={(open) => !open && setRecordForm(null)}
          >
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {!recordForm.id
                    ? t("Add subdomain")
                    : editingApex
                      ? t("Edit {name}", { name: domainDetail.name })
                      : t("Edit subdomain")}
                </DialogTitle>
                <DialogDescription>
                  {t("Saved to Cloudflare straight away.")}
                </DialogDescription>
              </DialogHeader>
              <form
                className="space-y-4"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const record =
                    recordForm.mode === "auto"
                      ? {
                          auto: true,
                          name: recordForm.name.trim() || "@",
                          type: "",
                          content: "",
                        }
                      : {
                          name: recordForm.name.trim() || "@",
                          type: recordForm.type,
                          content: recordForm.content.trim(),
                          // TTL and proxying are not worth a field each — automatic
                          // TTL and proxy-on are right for everything this page creates
                          ttl: 1,
                          proxied: ["A", "AAAA", "CNAME"].includes(
                            recordForm.type,
                          )
                            ? true
                            : undefined,
                        };

                  if (recordForm.id) {
                    await updateDnsRecord.mutateAsync({
                      recordId: recordForm.id,
                      record,
                    });
                  } else {
                    await createDnsRecord.mutateAsync(record);
                  }
                  setRecordForm(null);
                }}
              >
                {!editingApex && (
                  <div className="space-y-2">
                    <Label htmlFor="record-name">{t("Subdomain")}</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        id="record-name"
                        placeholder="app"
                        value={recordForm.name}
                        onChange={(e) =>
                          setRecordForm({ ...recordForm, name: e.target.value })
                        }
                      />
                      <span className="whitespace-nowrap text-sm text-muted-foreground">
                        .{domainDetail.name}
                      </span>
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <Label>{t("Destination")}</Label>
                  <Select
                    value={recordForm.mode}
                    onValueChange={(value) =>
                      setRecordForm({
                        ...recordForm,
                        mode: value as "auto" | "custom",
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">{t("This platform")}</SelectItem>
                      <SelectItem value="custom">{t("Somewhere else")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {recordForm.mode === "custom" && (
                  <div className="flex gap-2">
                    <Select
                      value={recordForm.type}
                      onValueChange={(value) =>
                        setRecordForm({ ...recordForm, type: value })
                      }
                    >
                      <SelectTrigger className="w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {["A", "AAAA", "CNAME", "TXT", "MX", "CAA"].map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      placeholder={
                        recordForm.type === "A"
                          ? "203.0.113.10"
                          : domainDetail.name
                      }
                      value={recordForm.content}
                      onChange={(e) =>
                        setRecordForm({
                          ...recordForm,
                          content: e.target.value,
                        })
                      }
                    />
                  </div>
                )}

                <div className="flex items-center justify-end gap-3 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setRecordForm(null)}
                  >
                    {t("Cancel")}
                  </Button>
                  <Button
                    type="submit"
                    disabled={
                      (recordForm.mode === "custom" &&
                        !recordForm.content.trim()) ||
                      createDnsRecord.isPending ||
                      updateDnsRecord.isPending
                    }
                  >
                    {(createDnsRecord.isPending ||
                      updateDnsRecord.isPending) && (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    )}
                    {recordForm.id ? t("Save") : t("Add")}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        )}

        {recordToDelete && (
          <AlertDialog
            open={!!recordToDelete}
            onOpenChange={() => setRecordToDelete(null)}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("Delete DNS record")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {recordToDelete.type} {recordToDelete.name} →{" "}
                  {recordToDelete.content}.{" "}
                  {t("Anything relying on this hostname stops resolving.")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  disabled={deleteDnsRecord.isPending}
                  onClick={async () => {
                    await deleteDnsRecord.mutateAsync(recordToDelete.id);
                    setRecordToDelete(null);
                  }}
                >
                  {deleteDnsRecord.isPending && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  {t("Delete")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

        {domainDetail && cloudflarePrompt && (
          <AlertDialog
            open={!!cloudflarePrompt}
            onOpenChange={() => setCloudflarePrompt(null)}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {cloudflarePrompt === "enable"
                    ? t("Move {name} to Cloudflare?", { name: domainDetail.name })
                    : t("Detach {name} from Cloudflare?", { name: domainDetail.name })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {cloudflarePrompt === "enable"
                    ? domainDetail.registrar === "RDASH"
                      ? t("DNS moves to Cloudflare. Existing records are copied across and the nameservers at the registrar are repointed.")
                      : t("DNS moves to Cloudflare. Set the nameservers we show you at your registrar to finish the switch.")
                    : t("The Cloudflare zone stays in place — repoint the nameservers at your registrar before deleting it.")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={async () => {
                    if (cloudflarePrompt === "enable") {
                      await enableCloudflare.mutateAsync(domainDetail.id);
                    } else {
                      await disableCloudflare.mutateAsync(domainDetail.id);
                    }
                    setCloudflarePrompt(null);
                  }}
                  disabled={
                    enableCloudflare.isPending || disableCloudflare.isPending
                  }
                >
                  {enableCloudflare.isPending || disableCloudflare.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      {t("Working…")}
                    </>
                  ) : cloudflarePrompt === "enable" ? (
                    t("Move to Cloudflare")
                  ) : (
                    t("Detach")
                  )}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

        {assignTarget && (
          <Dialog
            open={!!assignTarget}
            onOpenChange={(open) => !open && setAssignTarget(null)}
          >
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>{t("Assign organization")}</DialogTitle>
                <DialogDescription>
                  {t(
                    "Choose which organization owns {name}. Only its members can create applications on the domain.",
                    { name: assignTarget.name },
                  )}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <OrganizationCombobox
                  value={assignOrgId === UNASSIGNED ? null : assignOrgId}
                  onChange={(id) => setAssignOrgId(id ?? UNASSIGNED)}
                  noneLabel={t("Unassigned")}
                />
                <div className="flex items-center justify-end space-x-3">
                  <Button
                    variant="outline"
                    onClick={() => setAssignTarget(null)}
                  >
                    {t("Cancel")}
                  </Button>
                  <Button
                    disabled={bulkAssign.isPending}
                    onClick={async () => {
                      await bulkAssign.mutateAsync({
                        ids: [assignTarget.id],
                        organizationId:
                          assignOrgId === UNASSIGNED ? null : assignOrgId,
                      });
                      setAssignTarget(null);
                    }}
                  >
                    {bulkAssign.isPending && (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    )}
                    {t("Save")}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        )}

        {confirmAction && dialogContent && (
          <AlertDialog
            open={!!confirmAction}
            onOpenChange={() => setConfirmAction(null)}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{dialogContent.title}</AlertDialogTitle>
                <AlertDialogDescription>
                  {dialogContent.description}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={executeAction}
                  disabled={
                    deleteDomain.isPending ||
                    verifyDomain.isPending ||
                    renewDomain.isPending
                  }
                  className={
                    dialogContent.variant === "destructive"
                      ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      : ""
                  }
                >
                  {deleteDomain.isPending ||
                  verifyDomain.isPending ||
                  renewDomain.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      {t("Processing...")}
                    </>
                  ) : (
                    dialogContent.actionText
                  )}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </TooltipProvider>
  );
}
