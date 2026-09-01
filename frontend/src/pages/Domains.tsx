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
} from "@/hooks/useDomains";
import { useQuery } from "@tanstack/react-query";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { OrganizationFilter } from "@/components/OrganizationFilter";
import { getOrganizations } from "@/lib/organizations";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

// radix Select rejects an empty string value, so "no organization" needs a sentinel
const UNASSIGNED = "__unassigned__";
const ANY = "__any__";

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
    type: "delete" | "verify";
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
  // adding a domain provisions a real Cloudflare zone — admins only
  const admin = isAdmin();
  const { data: organizations = [] } = useQuery({
    queryKey: ["organizations"],
    queryFn: getOrganizations,
    enabled: admin,
  });
  const {
    data: domainDnsZone,
    isLoading: dnsZoneLoading,
    error: dnsZoneError,
  } = useDomainDnsZone(domainId);
  const { data: rdashDns, isLoading: rdashDnsLoading } = useRdashDns(
    domainId,
    domainDetail?.registrar === "RDASH"
  );

  const domains = domainsData?.data ?? [];
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
      cell: (domain) => {
        const secure = domain.sslStatus === "ACTIVE";
        const Icon = secure ? Globe : LockOpen;
        return (
          <div className="flex items-center space-x-2 font-medium">
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
              className="hover:underline"
            >
              {domain.name}
            </button>
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
      cell: (domain) =>
        domain.organization ? (
          <Badge variant="outline">{domain.organization.name}</Badge>
        ) : (
          <span className="text-muted-foreground">Unassigned</span>
        ),
    },
    {
      header: "Status",
      cell: (domain) => getStatusBadge(domain.status),
    },
    {
      header: "Expires",
      sortKey: "expiresAt",
      cell: (domain) => {
        if (!domain.expiresAt) {
          return <span className="text-muted-foreground">-</span>;
        }
        const expiry = new Date(domain.expiresAt);
        const daysLeft = Math.ceil(
          (expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        );
        return (
          <span
            className={
              daysLeft < 0
                ? "text-destructive font-medium"
                : daysLeft <= 30
                ? "text-warning font-medium"
                : ""
            }
          >
            {formatDate(expiry)}
            {daysLeft >= 0 && daysLeft <= 30 && (
              <span className="ml-1 text-xs">({daysLeft}d)</span>
            )}
            {daysLeft < 0 && <span className="ml-1 text-xs">(expired)</span>}
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
                    <h1 className="text-2xl font-semibold">
                      {domainDetail.name}
                    </h1>
                    {getStatusBadge(domainDetail.status)}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Domain DNS zone and SSL configuration.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
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

            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>Overview</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
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
                        ? "RDASH"
                        : domainDetail.registrar === "EXTERNAL"
                        ? "External"
                        : "Unknown"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Registration expiry</span>
                    <span>
                      {domainDetail.expiresAt
                        ? formatDate(new Date(domainDetail.expiresAt))
                        : "-"}
                    </span>
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
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                  <CardTitle className="flex items-center gap-2">
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
                  {admin && (
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-xs ${
                          domainDetail.cfZoneId
                            ? "text-muted-foreground"
                            : "font-medium text-warning"
                        }`}
                      >
                        {domainDetail.cfZoneId ? "On" : "Off"}
                      </span>
                      <Switch
                        checked={!!domainDetail.cfZoneId}
                        disabled={
                          enableCloudflare.isPending || disableCloudflare.isPending
                        }
                        onCheckedChange={(next) =>
                          setCloudflarePrompt(next ? "enable" : "disable")
                        }
                        aria-label="Cloudflare DNS"
                      />
                    </div>
                  )}
                </CardHeader>
                <CardContent className="space-y-3">
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
                      No Cloudflare zone yet — DNS and SSL are not managed for
                      this domain. Toggle on to create the zone and move DNS
                      across.
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>DNS Records</CardTitle>
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
                    Sync domains
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
                          <Select
                            value={newDomainOrgId}
                            onValueChange={setNewDomainOrgId}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select an organization" />
                            </SelectTrigger>
                            <SelectContent>
                              {organizations.map((org) => (
                                <SelectItem key={org.id} value={org.id}>
                                  {org.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
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
                                  handled externally or via RDASH.
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
                  <Select value={bulkOrgId} onValueChange={setBulkOrgId}>
                    <SelectTrigger className="w-64">
                      <SelectValue placeholder="Assign to organization" />
                    </SelectTrigger>
                    <SelectContent>
                      {organizations.map((org) => (
                        <SelectItem key={org.id} value={org.id}>
                          {org.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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

        {domainId && domainDetail?.registrar === "RDASH" && (
          <Card>
            <CardHeader>
              <CardTitle>Registrar DNS (RDASH)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {rdashDnsLoading ? (
                <div className="flex items-center text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Reading DNS
                  from RDASH…
                </div>
              ) : !rdashDns?.registered ? (
                <p className="text-sm text-muted-foreground">
                  This domain was not found in the RDASH account.
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
                      RDASH holds no DNS records for this domain.
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
                <AlertDialogDescription asChild>
                  {cloudflarePrompt === "enable" ? (
                    <div className="space-y-2">
                      <p>This will, in order:</p>
                      <ol className="list-decimal space-y-1 pl-5">
                        {domainDetail.registrar === "RDASH" && (
                          <li>
                            Save a copy of the DNS records RDASH currently
                            serves ({rdashDns?.records.length ?? 0} record
                            {(rdashDns?.records.length ?? 0) === 1 ? "" : "s"}).
                          </li>
                        )}
                        <li>Create the Cloudflare zone if it does not exist.</li>
                        <li>Copy those records into the new zone.</li>
                        <li>
                          {domainDetail.registrar === "RDASH"
                            ? "Change the nameservers at RDASH to Cloudflare's. DNS for this domain will start resolving from Cloudflare once it propagates."
                            : "Show you the nameservers to set at your registrar — we cannot change them for you."}
                        </li>
                      </ol>
                    </div>
                  ) : (
                    <span>
                      This only detaches the domain in CommitBase. The Cloudflare
                      zone is left in place — deleting it while the nameservers
                      still point there would take the domain offline. Repoint the
                      nameservers at your registrar first.
                    </span>
                  )}
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
                <Select value={assignOrgId} onValueChange={setAssignOrgId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select an organization" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                    {organizations.map((org) => (
                      <SelectItem key={org.id} value={org.id}>
                        {org.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                    deleteDomain.isPending || verifyDomain.isPending
                  }
                  className={
                    dialogContent.variant === "destructive"
                      ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      : ""
                  }
                >
                  {deleteDomain.isPending || verifyDomain.isPending ? (
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
