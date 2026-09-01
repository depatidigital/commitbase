import { useState } from "react";
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
  MoreHorizontal,
  Building2,
  RotateCw,
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
} from "@/hooks/useDomains";
import { useQuery } from "@tanstack/react-query";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { OrganizationFilter } from "@/components/OrganizationFilter";
import { OrganizationCombobox } from "@/components/OrganizationCombobox";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
import { APP_NAME } from '@/lib/branding';

// radix Select rejects an empty string value, so "no organization" needs a sentinel
const UNASSIGNED = "__unassigned__";
const ANY = "__any__";

// expired, or inside the 30-day window the Expires column already highlights
const needsRenewal = (domain: Pick<Domain, "expiresAt">) => {
  if (!domain.expiresAt) return false;
  const daysLeft =
    (new Date(domain.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  return daysLeft <= 30;
};

type ExpiryTone = {
  days: number;
  className: string;
  note: string;
  urgent: boolean;
};

/** How loudly to shout about a registration expiry date. */
const expiryTone = (value: Date): ExpiryTone => {
  const days = Math.ceil((value.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

  if (days < 0) {
    return { days, className: "text-destructive font-semibold", note: "expired", urgent: true };
  }
  if (days === 0) {
    return {
      days,
      className: "text-destructive font-semibold",
      note: "expires today",
      urgent: true,
    };
  }
  if (days <= 7) {
    return {
      days,
      className: "text-destructive font-semibold",
      note: `${days}d left`,
      urgent: true,
    };
  }
  if (days <= 30) {
    return { days, className: "text-warning font-medium", note: `${days}d left`, urgent: true };
  }
  if (days <= 60) {
    return { days, className: "text-warning", note: `${days}d left`, urgent: false };
  }
  return { days, className: "", note: "", urgent: false };
};

const formatDate = (value: Date) =>
  value.toLocaleDateString("id-ID", {
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
  const [addMode, setAddMode] = useState<"existing" | "register">("existing");
  const [newDomainName, setNewDomainName] = useState("");
  const [newDomainOrgId, setNewDomainOrgId] = useState("");
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
  const [cloudflarePrompt, setCloudflarePrompt] = useState<"enable" | "disable" | null>(null);
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
  const { data: domainsData, isLoading, error } = useDomainsPage({
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
    domainDetail?.registrar === "RDASH"
  );

  const domains = domainsData?.data ?? [];

  // a subdomain is any record in the zone whose name sits below the apex
  const subdomainRecords = (domainDnsZone?.records ?? []).filter(
    (record: any) =>
      typeof record?.name === "string" &&
      domainDetail?.name &&
      record.name !== domainDetail.name
  );
  const allSelected =
    domains.length > 0 && domains.every((d) => selectedIds.includes(d.id));

  const toggleAll = () =>
    setSelectedIds(allSelected ? [] : domains.map((d) => d.id));

  const toggleOne = (id: string) =>
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  const domainColumns: Column<(typeof domains)[number]>[] = [
    ...(admin
      ? [
          {
            header: (
              <Checkbox
                checked={allSelected}
                onCheckedChange={toggleAll}
                aria-label="Select all domains on this page"
              />
            ),
            className: "w-10",
            cell: (domain: Domain) => (
              <Checkbox
                checked={selectedIds.includes(domain.id)}
                onCheckedChange={() => toggleOne(domain.id)}
                aria-label={`Select ${domain.name}`}
              />
            ),
          },
        ]
      : []),
    {
      header: "Domain",
      sortKey: "name",
      className: "w-[26%]",
      cell: (domain) => {
        const secure = domain.sslStatus === "ACTIVE";
        const Icon = secure ? Globe : LockOpen;
        return (
          <div className="flex min-w-0 items-center space-x-2 font-medium">
            <Icon
              className={`h-4 w-4 ${
                secure ? "text-success" : "text-warning"
              }`}
              aria-label={
                secure ? "Secure — SSL active" : "Not secure — no active SSL"
              }
            />
            <button
              type="button"
              onClick={() => navigate(`/domains/${domain.id}`)}
              className="truncate hover:underline"
            >
              {domain.name}
            </button>
            {domain.registrar === "EXTERNAL" && (
              <Badge variant="secondary">External</Badge>
            )}
            {!domain.cfZoneId && (
              <Badge
                variant="outline"
                className="border-warning text-warning"
              >
                No zone
              </Badge>
            )}
          </div>
        );
      },
    },
    {
      header: "Organization",
      className: "w-[26%]",
      cell: (domain) =>
        domain.organization ? (
          <Badge variant="outline" className="max-w-full truncate">
            {domain.organization.name}
          </Badge>
        ) : (
          <span className="text-muted-foreground">Unassigned</span>
        ),
    },
    {
      header: "Status",
      className: "w-28",
      cell: (domain) => getStatusBadge(domain.status),
    },
    {
      header: "Expires",
      sortKey: "expiresAt",
      className: "w-64",
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
            {formatDate(expiry)}
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
                Renew
              </Button>
            )}
          </span>
        );
      },
    },
    {
      header: "Actions",
      className: "w-16",
      cell: (domain) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              aria-label={`Actions for ${domain.name}`}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => navigate(`/domains/${domain.id}`)}>
              <Eye className="mr-2 h-4 w-4" />
              View details
            </DropdownMenuItem>
            {admin && (
              <DropdownMenuItem
                onClick={() => {
                  setAssignTarget({ id: domain.id, name: domain.name });
                  setAssignOrgId(domain.organization?.id ?? UNASSIGNED);
                }}
              >
                <Building2 className="mr-2 h-4 w-4" />
                Assign organization
              </DropdownMenuItem>
            )}
            {admin && needsRenewal(domain) && (
              <DropdownMenuItem
                onClick={() => handleRenew(domain)}
                disabled={renewDomain.isPending}
              >
                <RotateCw className="mr-2 h-4 w-4" />
                Renew registration
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => handleVerify(domain.id, domain.name)}
              disabled={verifyDomain.isPending}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Verify DNS
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => handleDelete(domain.id, domain.name)}
              disabled={deleteDomain.isPending}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete domain
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
            <h3 className="text-lg font-semibold mb-2">Error Loading Domain</h3>
            <p className="text-muted-foreground mb-4">
              Failed to load domain. Please try again.
            </p>
            <Button variant="outline" onClick={() => navigate("/domains")}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to domains
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
        title: "External domain",
        description: `${domain.name} is registered outside ${APP_NAME}. Renew it with the registrar you bought it from.`,
      });
      return;
    }
    setConfirmAction({ type: "renew", domainId: domain.id, domainName: domain.name });
  };

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
        customConfig: {
          mode: addMode,
        },
      });

      setAddDialogOpen(false);
      setNewDomainName("");
      setNewDomainOrgId("");
      setAddMode("existing");
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
          title: "Delete Domain",
          description: `Are you sure you want to delete "${domainName}"? This action cannot be undone and will remove all associated DNS records and SSL certificates.`,
          actionText: "Delete Domain",
          variant: "destructive" as const,
        };
      case "verify":
        return {
          title: "Verify Domain DNS",
          description: `Are you sure you want to verify the DNS records for "${domainName}"? This will check if the domain is properly configured.`,
          actionText: "Verify DNS",
          variant: "default" as const,
        };
      case "renew":
        return {
          title: "Renew Domain",
          description: `Renew "${domainName}" for 1 year at the registrar? This charges your registrar account and cannot be undone.`,
          actionText: "Renew for 1 year",
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

  const getStatusBadge = (status: string) => {
    const variants = {
      ACTIVE: "default",
      INACTIVE: "secondary",
      PENDING: "outline",
      ERROR: "destructive",
    } as const;

    return (
      <Badge
        variant={variants[status as keyof typeof variants] || "secondary"}
        className="gap-1"
      >
        {getStatusIcon(status)}
        {status.toLowerCase()}
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
        className="gap-1"
      >
        {getSSLIcon(sslStatus)}
        {sslStatus.toLowerCase()}
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
              Error Loading Domains
            </h3>
            <p className="text-muted-foreground">
              Failed to load domains. Please try again.
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
                  aria-label="Back to domains"
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
                        const tone = expiryTone(new Date(domainDetail.expiresAt));
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
                              ? "Registration expired"
                              : `Expires ${tone.note}`}
                          </Badge>
                        );
                      })()}
                    {getStatusBadge(domainDetail.status)}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Domain DNS zone and SSL configuration.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {admin && needsRenewal(domainDetail) && (
                  <Button
                    size="sm"
                    onClick={() =>
                      handleRenew(domainDetail)
                    }
                    disabled={renewDomain.isPending}
                  >
                    <RotateCw className="h-4 w-4 mr-2" />
                    Renew
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
                      Verifying
                    </>
                  ) : (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Verify DNS
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
                      Deleting
                    </>
                  ) : (
                    <>
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </>
                  )}
                </Button>
              </div>
            </div>

            <Tabs defaultValue="overview" className="space-y-4">
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="subdomains">Subdomains</TabsTrigger>
                <TabsTrigger value="dns">DNS</TabsTrigger>
                <TabsTrigger value="registration">Registration</TabsTrigger>
                {admin && (
                  <TabsTrigger value="settings">Settings</TabsTrigger>
                )}
              </TabsList>

              <TabsContent value="overview" className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Overview</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 pt-0">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Status</span>
                      {getStatusBadge(domainDetail.status)}
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">SSL</span>
                      {getSSLBadge(domainDetail.sslStatus)}
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Registrar</span>
                      <span>
                        {domainDetail.registrar === "RDASH"
                          ? "Managed"
                          : domainDetail.registrar === "EXTERNAL"
                          ? "External"
                          : "Unknown"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Registration expiry</span>
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
                                <span className="ml-1 text-xs">({tone.note})</span>
                              )}
                            </span>
                          );
                        })()
                      ) : (
                        <span>-</span>
                      )}
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">SSL expiry</span>
                      <span>
                        {domainDetail.sslExpiry
                          ? formatDate(new Date(domainDetail.sslExpiry))
                          : "-"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Redirect to</span>
                      <span className="flex items-center gap-2">
                        {domainDetail.redirectTo ? (
                          <>
                            <ExternalLink className="h-3 w-3 text-muted-foreground" />
                            <span className="text-sm text-muted-foreground">
                              {domainDetail.redirectTo}
                            </span>
                          </>
                        ) : (
                          "-"
                        )}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Created</span>
                      <span>
                        {formatDate(new Date(domainDetail.createdAt))}
                      </span>
                    </div>
                  </CardContent>
                </Card>

                <Card
                  className={
                    domainDetail.cfZoneId
                      ? undefined
                      : "border-warning/50 bg-warning/5"
                  }
                >
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                      Cloudflare Zone
                      {!domainDetail.cfZoneId && (
                        <Badge
                          variant="outline"
                          className="border-warning text-warning gap-1"
                        >
                          <AlertCircle className="h-3.5 w-3.5" />
                          Not configured
                        </Badge>
                      )}
                    </CardTitle>
                    {admin && !domainDetail.cfZoneId && (
                      <Button
                        size="sm"
                        onClick={() => setCloudflarePrompt("enable")}
                        disabled={enableCloudflare.isPending}
                      >
                        {enableCloudflare.isPending && (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        )}
                        Move to Cloudflare
                      </Button>
                    )}
                  </CardHeader>
                  <CardContent className="space-y-2 pt-0">
                    {dnsZoneLoading ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Loading DNS zone from Cloudflare...</span>
                      </div>
                    ) : dnsZoneError ? (
                      <p className="text-sm text-destructive">
                        Failed to load DNS zone configuration.
                      </p>
                    ) : domainDnsZone && domainDnsZone.zone ? (
                      <div className="space-y-2 text-sm">
                        <div className="flex items-center gap-2">
                          <Globe className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium">
                            {domainDnsZone.zone.name}
                          </span>
                        </div>
                        {domainDnsZone.zone.nameservers.length > 0 && (
                          <div className="space-y-1">
                            <p className="text-xs text-muted-foreground">
                              Nameservers
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {domainDnsZone.zone.nameservers.map(
                                (ns: string) => (
                                  <Badge key={ns} variant="outline">
                                    {ns}
                                  </Badge>
                                ),
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-warning">
                        No Cloudflare zone yet — DNS and SSL are not managed
                        for this domain. Use Move to Cloudflare to create the
                        zone and migrate DNS.
                      </p>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                    <CardTitle className="text-base">Subdomains</CardTitle>
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
                        Add
                      </Button>
                    )}
                  </CardHeader>
                  <CardContent>
                    {!domainDetail.cfZoneId ? (
                      <p className="text-sm text-muted-foreground">
                        Move this domain to Cloudflare to manage subdomains.
                      </p>
                    ) : subdomainRecords.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        None yet.
                      </p>
                    ) : (
                      <div className="space-y-1">
                        {subdomainRecords.slice(0, 5).map((record: any) => (
                          <div
                            key={record.id}
                            className="flex items-center justify-between gap-2 text-sm"
                          >
                            <span className="font-mono text-xs">
                              {record.name}
                            </span>
                            <span className="truncate font-mono text-xs text-muted-foreground">
                              {record.type} → {record.content}
                            </span>
                          </div>
                        ))}
                        {subdomainRecords.length > 5 && (
                          <p className="pt-1 text-xs text-muted-foreground">
                            +{subdomainRecords.length - 5} more in the
                            Subdomains tab
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
                    <CardTitle className="text-base">Subdomains</CardTitle>
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
                        Add subdomain
                      </Button>
                    )}
                  </CardHeader>
                  <CardContent>
                    {!domainDetail.cfZoneId ? (
                      <p className="text-sm text-warning">
                        Move this domain to Cloudflare before managing
                        subdomains.
                      </p>
                    ) : dnsZoneLoading ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Loading subdomains…</span>
                      </div>
                    ) : subdomainRecords.length === 0 ? (
                      <div className="space-y-3">
                        <p className="text-sm text-muted-foreground">
                          No subdomains yet. Add one, or pull across whatever
                          the registrar was serving.
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
                          Sync from registrar DNS
                        </Button>
                      </div>
                    ) : (
                      <div className="rounded-md border overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Subdomain</TableHead>
                              <TableHead>Type</TableHead>
                              <TableHead>Target</TableHead>
                              <TableHead>Proxied</TableHead>
                              <TableHead className="text-right">TTL</TableHead>
                              <TableHead className="w-12" />
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {subdomainRecords.map((record: any) => (
                              <TableRow key={record.id}>
                                <TableCell className="font-mono text-xs">
                                  {record.name.replace(
                                    `.${domainDetail.name}`,
                                    ""
                                  )}
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                  {record.type}
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                  {record.content}
                                </TableCell>
                                <TableCell>
                                  {record.proxied ? (
                                    <Badge variant="secondary">Proxied</Badge>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">
                                      DNS only
                                    </span>
                                  )}
                                </TableCell>
                                <TableCell className="text-right text-xs">
                                  {record.ttl === 1 ? "Auto" : record.ttl}
                                </TableCell>
                                <TableCell>
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 w-8 p-0"
                                        aria-label={`Actions for ${record.name}`}
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
                                            name: record.name.replace(
                                              `.${domainDetail.name}`,
                                              ""
                                            ),
                                            type: record.type,
                                            content: record.content,
                                            ttl: String(record.ttl ?? 1),
                                            proxied: !!record.proxied,
                                          })
                                        }
                                      >
                                        <Edit className="mr-2 h-4 w-4" />
                                        Edit
                                      </DropdownMenuItem>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem
                                        className="text-destructive focus:text-destructive"
                                        onClick={() => setRecordToDelete(record)}
                                      >
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        Delete
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
                  <CardTitle className="text-base">DNS Records</CardTitle>
                </CardHeader>
                <CardContent>
                  {dnsZoneLoading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Loading DNS records...</span>
                    </div>
                  ) : domainDnsZone && domainDnsZone.records.length > 0 ? (
                    <div className="rounded-md border border-border/60 bg-muted/20 max-h-96 overflow-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-[80px]">Type</TableHead>
                            <TableHead>Name</TableHead>
                            <TableHead>Content</TableHead>
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
                      No DNS records found in Cloudflare for this domain.
                    </p>
                  )}
                </CardContent>
              </Card>
                {domainDetail.registrar === "RDASH" && (
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">Registrar DNS</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 pt-0">
                      {rdashDnsLoading ? (
                        <div className="flex items-center text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Reading DNS
                          from the registrar…
                        </div>
                      ) : !rdashDns?.registered ? (
                        <p className="text-sm text-muted-foreground">
                          This domain was not found at the registrar.
                        </p>
                      ) : (
                        <>
                          <div className="text-sm">
                            <span className="text-muted-foreground">Nameservers: </span>
                            <span className="font-mono text-xs">
                              {rdashDns.nameservers.join(", ") || "-"}
                            </span>
                            {rdashDns.delegatedToCloudflare && (
                              <Badge variant="secondary" className="ml-2">
                                Delegated to Cloudflare
                              </Badge>
                            )}
                          </div>
                          {rdashDns.records.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                              The registrar holds no DNS records for this domain.
                            </p>
                          ) : (
                            <div className="rounded-md border overflow-x-auto">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>Type</TableHead>
                                    <TableHead>Name</TableHead>
                                    <TableHead>Content</TableHead>
                                    <TableHead className="text-right">TTL</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {rdashDns.records.map((record: any, i: number) => (
                                    <TableRow key={record.id ?? i}>
                                      <TableCell className="font-mono text-xs">
                                        {record.type ?? record.record_type ?? "-"}
                                      </TableCell>
                                      <TableCell className="font-mono text-xs">
                                        {record.name ?? record.host ?? "@"}
                                      </TableCell>
                                      <TableCell className="font-mono text-xs">
                                        {record.content ?? record.value ?? record.data ?? "-"}
                                      </TableCell>
                                      <TableCell className="text-right text-xs">
                                        {record.ttl ?? "-"}
                                      </TableCell>
                                    </TableRow>
                                  ))}
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
                    <CardTitle className="text-base">Registration</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {registrationLoading ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Looking up the registry record…</span>
                      </div>
                    ) : !registration ? (
                      <p className="text-sm text-muted-foreground">
                        This TLD publishes no public registry record, or the
                        domain is not registered.
                      </p>
                    ) : (
                      <>
                        <div className="flex items-center justify-between gap-4 text-sm">
                          <span className="text-muted-foreground">
                            Registered with
                          </span>
                          <span className="text-right">
                            {registration.registrar ?? "Unknown"}
                            {registration.registrarId && (
                              <span className="ml-1 text-xs text-muted-foreground">
                                (IANA {registration.registrarId})
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">
                            Registered on
                          </span>
                          <span>
                            {registration.registeredAt
                              ? formatDate(new Date(registration.registeredAt))
                              : "-"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">
                            Last changed
                          </span>
                          <span>
                            {registration.updatedAt
                              ? formatDate(new Date(registration.updatedAt))
                              : "-"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Expires</span>
                          <span>
                            {registration.expiresAt
                              ? formatDate(new Date(registration.expiresAt))
                              : "-"}
                          </span>
                        </div>
                        {registration.status.length > 0 && (
                          <div className="space-y-1 text-sm">
                            <span className="text-muted-foreground">
                              Registry status
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
                              Nameservers at the registry
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
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Cloudflare</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 pt-0">
                    {domainDetail.cfZoneId ? (
                      <>
                        <p className="text-sm text-muted-foreground">
                          DNS for this domain is managed in Cloudflare zone{" "}
                          <span className="font-mono text-xs">
                            {domainDetail.cfZoneId}
                          </span>
                          . Detaching only stops {APP_NAME} managing it — the zone
                          stays in Cloudflare and the nameservers keep pointing
                          there until you change them at the registrar.
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
                          Detach from Cloudflare
                        </Button>
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        This domain is not attached to Cloudflare.
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
              title="Domains"
              description="Manage your custom domains and SSL certificates."
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
                    {syncDomains.isPending ? "Syncing…" : "Sync domains"}
                  </Button>
                  <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
                    <Button
                      className="bg-gradient-primary shadow-glow hover:shadow-elegant transition-all duration-300"
                      onClick={() => setAddDialogOpen(true)}
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Add Domain
                    </Button>
                    <DialogContent className="max-w-lg">
                      <DialogHeader>
                        <DialogTitle>Add Domain</DialogTitle>
                        <DialogDescription>
                          Connect an existing domain or register a new one
                          through your registrar.
                        </DialogDescription>
                      </DialogHeader>
                      <form onSubmit={handleAddDomain} className="space-y-6">
                        <div className="space-y-2">
                          <Label className="text-sm">Owning organization</Label>
                          <OrganizationCombobox
                            value={newDomainOrgId || null}
                            onChange={(id) => setNewDomainOrgId(id ?? "")}
                          />
                          <p className="text-xs text-muted-foreground">
                            Only this organization's members can create
                            applications on it.
                          </p>
                        </div>
                        <div className="space-y-3">
                          <Label className="text-sm">Domain type</Label>
                          <RadioGroup
                            className="grid grid-cols-1 md:grid-cols-2 gap-3"
                            value={addMode}
                            onValueChange={(value) =>
                              setAddMode(value as "existing" | "register")
                            }
                          >
                            <div className="flex items-start space-x-3 rounded-md border border-border/60 bg-muted/40 p-3">
                              <RadioGroupItem
                                value="existing"
                                id="domain-mode-existing"
                              />
                              <div className="space-y-1">
                                <Label htmlFor="domain-mode-existing">
                                  Use existing domain
                                </Label>
                                <p className="text-xs text-muted-foreground">
                                  Use a domain you already own and connect it to
                                  Cloudflare automatically.
                                </p>
                              </div>
                            </div>
                            <div className="flex items-start space-x-3 rounded-md border border-border/60 bg-muted/20 p-3">
                              <RadioGroupItem
                                value="register"
                                id="domain-mode-register"
                              />
                              <div className="space-y-1">
                                <Label htmlFor="domain-mode-register">
                                  Register new domain
                                </Label>
                                <p className="text-xs text-muted-foreground">
                                  Mark this domain as new. Registration is
                                  handled externally or through the registrar.
                                </p>
                              </div>
                            </div>
                          </RadioGroup>
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="new-domain-name">Domain name</Label>
                          <Input
                            id="new-domain-name"
                            placeholder="example.com"
                            value={newDomainName}
                            onChange={(e) => setNewDomainName(e.target.value)}
                          />
                        </div>

                        <div className="flex items-center justify-end space-x-3 pt-2">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => setAddDialogOpen(false)}
                          >
                            Cancel
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
                            Save domain
                          </Button>
                        </div>
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
                    <TabsTrigger value="all">All</TabsTrigger>
                    <TabsTrigger value="unassigned">Unassigned</TabsTrigger>
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
                    <SelectValue placeholder="Any status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>Any status</SelectItem>
                    <SelectItem value="ACTIVE">Active</SelectItem>
                    <SelectItem value="PENDING">Pending</SelectItem>
                    <SelectItem value="INACTIVE">Inactive</SelectItem>
                    <SelectItem value="ERROR">Error</SelectItem>
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
                    <SelectValue placeholder="Any expiration" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>Any expiration</SelectItem>
                    <SelectItem value="expired">Expired</SelectItem>
                    <SelectItem value="30">Expiring in 30 days</SelectItem>
                    <SelectItem value="60">Expiring in 60 days</SelectItem>
                    <SelectItem value="90">Expiring in 90 days</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {admin && selectedIds.length > 0 && (
                <div className="flex flex-wrap items-center gap-3 rounded-md border border-border/60 bg-muted/40 p-3">
                  <span className="text-sm font-medium">
                    {selectedIds.length} selected
                  </span>
                  <OrganizationCombobox
                    value={bulkOrgId || null}
                    onChange={(id) => setBulkOrgId(id ?? "")}
                    placeholder="Assign to organization"
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
                    Assign
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelectedIds([])}
                  >
                    Clear
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
                searchPlaceholder="Search domains…"
                empty={
                  admin
                    ? "No domains yet — add your first custom domain."
                    : "No domains are assigned to your organization yet. Ask an administrator to assign one."
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
                  {recordForm.id ? "Edit subdomain" : "Add subdomain"}
                </DialogTitle>
                <DialogDescription>
                  Written straight to the Cloudflare zone for{" "}
                  {domainDetail.name}.
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
                          ttl: Number(recordForm.ttl) || 1,
                          proxied: ["A", "AAAA", "CNAME"].includes(recordForm.type)
                            ? recordForm.proxied
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
                <div className="space-y-2">
                  <Label htmlFor="record-name">Subdomain</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="record-name"
                      placeholder="app"
                      value={recordForm.name}
                      onChange={(e) =>
                        setRecordForm({ ...recordForm, name: e.target.value })
                      }
                    />
                    <span className="text-sm text-muted-foreground">
                      .{domainDetail.name}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Leave empty to use the domain itself.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Points to</Label>
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
                      <SelectItem value="auto">
                        Auto — this platform
                      </SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                  {recordForm.mode === "auto" && (
                    <p className="text-xs text-muted-foreground">
                      Uses the platform's configured DNS target, as an A record
                      or CNAME depending on what it is.
                    </p>
                  )}
                </div>

                {recordForm.mode === "custom" && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>Type</Label>
                    <Select
                      value={recordForm.type}
                      onValueChange={(value) =>
                        setRecordForm({ ...recordForm, type: value })
                      }
                    >
                      <SelectTrigger>
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
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="record-ttl">TTL</Label>
                    <Input
                      id="record-ttl"
                      value={recordForm.ttl}
                      onChange={(e) =>
                        setRecordForm({ ...recordForm, ttl: e.target.value })
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      1 = automatic
                    </p>
                  </div>
                </div>
                )}

                {recordForm.mode === "custom" && (
                <div className="space-y-2">
                  <Label htmlFor="record-content">
                    {recordForm.type === "CNAME" ? "Target" : "Value"}
                  </Label>
                  <Input
                    id="record-content"
                    placeholder={
                      recordForm.type === "A"
                        ? "203.0.113.10"
                        : domainDetail.name
                    }
                    value={recordForm.content}
                    onChange={(e) =>
                      setRecordForm({ ...recordForm, content: e.target.value })
                    }
                  />
                </div>
                )}

                {recordForm.mode === "custom" &&
                  ["A", "AAAA", "CNAME"].includes(recordForm.type) && (
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div>
                      <Label className="text-sm">Proxy through Cloudflare</Label>
                      <p className="text-xs text-muted-foreground">
                        Hides the origin IP and serves the certificate.
                      </p>
                    </div>
                    <Switch
                      checked={recordForm.proxied}
                      onCheckedChange={(next) =>
                        setRecordForm({ ...recordForm, proxied: next })
                      }
                    />
                  </div>
                )}

                <div className="flex items-center justify-end gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setRecordForm(null)}
                  >
                    Cancel
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
                    {(createDnsRecord.isPending || updateDnsRecord.isPending) && (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    )}
                    {recordForm.id ? "Save" : "Add"}
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
                <AlertDialogTitle>Delete DNS record</AlertDialogTitle>
                <AlertDialogDescription>
                  {recordToDelete.type} {recordToDelete.name} →{" "}
                  {recordToDelete.content}. Anything relying on this hostname
                  stops resolving.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
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
                  Delete
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
                    ? `Move ${domainDetail.name} to Cloudflare?`
                    : `Detach ${domainDetail.name} from Cloudflare?`}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {cloudflarePrompt === "enable"
                    ? domainDetail.registrar === "RDASH"
                      ? "DNS moves to Cloudflare. Existing records are copied across and the nameservers at the registrar are repointed."
                      : "DNS moves to Cloudflare. Set the nameservers we show you at your registrar to finish the switch."
                    : "The Cloudflare zone stays in place — repoint the nameservers at your registrar before deleting it."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
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
                      Working…
                    </>
                  ) : cloudflarePrompt === "enable" ? (
                    "Move to Cloudflare"
                  ) : (
                    "Detach"
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
                <DialogTitle>Assign organization</DialogTitle>
                <DialogDescription>
                  Choose which organization owns {assignTarget.name}. Only its
                  members can create applications on the domain.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <OrganizationCombobox
                  value={assignOrgId === UNASSIGNED ? null : assignOrgId}
                  onChange={(id) => setAssignOrgId(id ?? UNASSIGNED)}
                  noneLabel="Unassigned"
                />
                <div className="flex items-center justify-end space-x-3">
                  <Button
                    variant="outline"
                    onClick={() => setAssignTarget(null)}
                  >
                    Cancel
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
                    Save
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
                <AlertDialogCancel>Cancel</AlertDialogCancel>
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
                      Processing...
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
