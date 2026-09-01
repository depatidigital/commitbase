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
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  useDomainsPage,
  useDomains,
  useDomain,
  useDeleteDomain,
  useVerifyDomain,
  useRenewSSL,
  useCreateDomain,
  useDomainDnsZone,
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
  const { toast } = useToast();

  // API hooks
  const { data: domainsData, isLoading, error } = useDomainsPage(query.params);
  const {
    data: domainDetail,
    isLoading: domainLoading,
    error: domainError,
  } = useDomain(domainId || "");
  const deleteDomain = useDeleteDomain();
  const verifyDomain = useVerifyDomain();
  const renewSSL = useRenewSSL();
  const createDomain = useCreateDomain();
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

  const domains = domainsData?.data ?? [];

  const domainColumns: Column<(typeof domains)[number]>[] = [
    {
      header: "Domain",
      cell: (domain) => (
        <div className="flex items-center space-x-2 font-medium">
          <Globe className="h-4 w-4 text-muted-foreground" />
          <span>{domain.name}</span>
        </div>
      ),
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
      cell: (domain) => (
        <div className="flex items-center space-x-2">
          {getStatusIcon(domain.status)}
          {getStatusBadge(domain.status)}
        </div>
      ),
    },
    {
      header: "SSL Status",
      cell: (domain) => (
        <div className="flex items-center space-x-2">
          {getSSLIcon(domain.sslStatus)}
          {getSSLBadge(domain.sslStatus)}
        </div>
      ),
    },
    {
      header: "SSL Expiry",
      cell: (domain) =>
        domain.sslExpiry
          ? new Date(domain.sslExpiry).toLocaleDateString()
          : "-",
    },
    {
      header: "Redirect To",
      cell: (domain) =>
        domain.redirectTo ? (
          <div className="flex items-center space-x-2">
            <ExternalLink className="h-3 w-3 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {domain.redirectTo}
            </span>
          </div>
        ) : (
          "-"
        ),
    },
    {
      header: "Created",
      cell: (domain) => new Date(domain.createdAt).toLocaleDateString(),
    },
    {
      header: "Actions",
      cell: (domain) => (
        <div className="flex items-center space-x-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate(`/domains/${domain.id}`)}
                aria-label={`View details for ${domain.name}`}
                className="h-8 w-8 p-0"
              >
                <Eye className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>View domain details</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleVerify(domain.id, domain.name)}
                aria-label={`Verify ${domain.name}`}
                disabled={verifyDomain.isPending}
                className="h-8 w-8 p-0"
              >
                {verifyDomain.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Verify DNS records</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleRenewSSL(domain.id, domain.name)}
                aria-label={`Renew SSL for ${domain.name}`}
                disabled={renewSSL.isPending}
                className="h-8 w-8 p-0"
              >
                {renewSSL.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Shield className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Renew SSL certificate</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleDelete(domain.id, domain.name)}
                aria-label={`Delete ${domain.name}`}
                disabled={deleteDomain.isPending}
                className="h-8 w-8 p-0 text-destructive hover:text-destructive"
              >
                {deleteDomain.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Delete domain</p>
            </TooltipContent>
          </Tooltip>
        </div>
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

  const handleRenewSSL = async (id: string, name: string) => {
    setConfirmAction({ type: "renew", domainId: id, domainName: name });
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
          await renewSSL.mutateAsync(confirmAction.domainId);
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
          title: "Renew SSL Certificate",
          description: `Are you sure you want to renew the SSL certificate for "${domainName}"? This will generate a new certificate valid for one year.`,
          actionText: "Renew SSL",
          variant: "default" as const,
        };
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "ACTIVE":
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case "INACTIVE":
        return <XCircle className="h-4 w-4 text-gray-500" />;
      case "PENDING":
        return <Clock className="h-4 w-4 text-yellow-500" />;
      case "ERROR":
        return <AlertCircle className="h-4 w-4 text-red-500" />;
      default:
        return <Clock className="h-4 w-4 text-gray-500" />;
    }
  };

  const getSSLIcon = (sslStatus: string) => {
    switch (sslStatus) {
      case "ACTIVE":
        return <ShieldCheck className="h-4 w-4 text-green-500" />;
      case "PENDING":
        return <Shield className="h-4 w-4 text-yellow-500" />;
      case "EXPIRED":
        return <ShieldX className="h-4 w-4 text-red-500" />;
      case "ERROR":
        return <ShieldX className="h-4 w-4 text-red-500" />;
      default:
        return <Shield className="h-4 w-4 text-gray-500" />;
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
      <Badge variant={variants[status as keyof typeof variants] || "secondary"}>
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
      >
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
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    handleRenewSSL(domainDetail.id, domainDetail.name)
                  }
                  disabled={renewSSL.isPending}
                >
                  {renewSSL.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Renewing
                    </>
                  ) : (
                    <>
                      <Shield className="h-4 w-4 mr-2" />
                      Renew SSL
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
                    <div className="flex items-center gap-2">
                      {getStatusIcon(domainDetail.status)}
                      {getStatusBadge(domainDetail.status)}
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">SSL</span>
                    <div className="flex items-center gap-2">
                      {getSSLIcon(domainDetail.sslStatus)}
                      {getSSLBadge(domainDetail.sslStatus)}
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">SSL expiry</span>
                    <span>
                      {domainDetail.sslExpiry
                        ? new Date(domainDetail.sslExpiry).toLocaleDateString()
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
                      {new Date(domainDetail.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Cloudflare Zone</CardTitle>
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
                    <p className="text-sm text-muted-foreground">
                      Cloudflare zone is not configured for this domain.
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
                ) : null
              }
            >
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
                toolbar={
                  <>
                    <OrganizationFilter query={query} />
                    <div className="flex items-center space-x-2 text-sm text-muted-foreground">
                      <Globe className="h-4 w-4 text-primary" />
                      <span>{domainsData?.pagination.total ?? 0} domains</span>
                    </div>
                  </>
                }
              />
            </PageLayout>
          </>
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
                    renewSSL.isPending
                  }
                  className={
                    dialogContent.variant === "destructive"
                      ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      : ""
                  }
                >
                  {deleteDomain.isPending ||
                  verifyDomain.isPending ||
                  renewSSL.isPending ? (
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
