import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
  Settings
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useDomains, useDeleteDomain, useVerifyDomain, useRenewSSL, useCreateDomain } from "@/hooks/useDomains";
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
import { Label } from "@/components/ui/label";

export default function Domains() {
  const [searchTerm, setSearchTerm] = useState("");
  const [confirmAction, setConfirmAction] = useState<{
    type: 'delete' | 'verify' | 'renew';
    domainId: string;
    domainName: string;
  } | null>(null);
  const [selectedDomain, setSelectedDomain] = useState<Domain | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addMode, setAddMode] = useState<'existing' | 'register'>('existing');
  const [newDomainName, setNewDomainName] = useState('');
  const [newRedirectTo, setNewRedirectTo] = useState('');
  const { toast } = useToast();
  
  // API hooks
  const { data: domainsData, isLoading, error } = useDomains();
  const deleteDomain = useDeleteDomain();
  const verifyDomain = useVerifyDomain();
  const renewSSL = useRenewSSL();
  const createDomain = useCreateDomain();

  const domains = domainsData || [];
  const filteredDomains = domains.filter(domain =>
    domain.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleDelete = async (id: string, name: string) => {
    setConfirmAction({ type: 'delete', domainId: id, domainName: name });
  };

  const handleVerify = async (id: string, name: string) => {
    setConfirmAction({ type: 'verify', domainId: id, domainName: name });
  };

  const handleRenewSSL = async (id: string, name: string) => {
    setConfirmAction({ type: 'renew', domainId: id, domainName: name });
  };

  const handleAddDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = newDomainName.trim();
    if (!value) {
      return;
    }

    try {
      await createDomain.mutateAsync({
        name: value,
        redirectTo: newRedirectTo || undefined,
        customConfig: {
          mode: addMode,
        },
      });

      setAddDialogOpen(false);
      setNewDomainName('');
      setNewRedirectTo('');
      setAddMode('existing');
    } catch {
    }
  };

  const executeAction = async () => {
    if (!confirmAction) return;

    try {
      switch (confirmAction.type) {
        case 'delete':
          await deleteDomain.mutateAsync(confirmAction.domainId);
          break;
        case 'verify':
          await verifyDomain.mutateAsync(confirmAction.domainId);
          break;
        case 'renew':
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
      case 'delete':
        return {
          title: 'Delete Domain',
          description: `Are you sure you want to delete "${domainName}"? This action cannot be undone and will remove all associated DNS records and SSL certificates.`,
          actionText: 'Delete Domain',
          variant: 'destructive' as const,
        };
      case 'verify':
        return {
          title: 'Verify Domain DNS',
          description: `Are you sure you want to verify the DNS records for "${domainName}"? This will check if the domain is properly configured.`,
          actionText: 'Verify DNS',
          variant: 'default' as const,
        };
      case 'renew':
        return {
          title: 'Renew SSL Certificate',
          description: `Are you sure you want to renew the SSL certificate for "${domainName}"? This will generate a new certificate valid for one year.`,
          actionText: 'Renew SSL',
          variant: 'default' as const,
        };
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'ACTIVE':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'INACTIVE':
        return <XCircle className="h-4 w-4 text-gray-500" />;
      case 'PENDING':
        return <Clock className="h-4 w-4 text-yellow-500" />;
      case 'ERROR':
        return <AlertCircle className="h-4 w-4 text-red-500" />;
      default:
        return <Clock className="h-4 w-4 text-gray-500" />;
    }
  };

  const getSSLIcon = (sslStatus: string) => {
    switch (sslStatus) {
      case 'ACTIVE':
        return <ShieldCheck className="h-4 w-4 text-green-500" />;
      case 'PENDING':
        return <Shield className="h-4 w-4 text-yellow-500" />;
      case 'EXPIRED':
        return <ShieldX className="h-4 w-4 text-red-500" />;
      case 'ERROR':
        return <ShieldX className="h-4 w-4 text-red-500" />;
      default:
        return <Shield className="h-4 w-4 text-gray-500" />;
    }
  };

  const getStatusBadge = (status: string) => {
    const variants = {
      ACTIVE: 'default',
      INACTIVE: 'secondary',
      PENDING: 'outline',
      ERROR: 'destructive',
    } as const;

    return (
      <Badge variant={variants[status as keyof typeof variants] || 'secondary'}>
        {status.toLowerCase()}
      </Badge>
    );
  };

  const getSSLBadge = (sslStatus: string) => {
    const variants = {
      ACTIVE: 'default',
      PENDING: 'outline',
      EXPIRED: 'destructive',
      ERROR: 'destructive',
    } as const;

    return (
      <Badge variant={variants[sslStatus as keyof typeof variants] || 'secondary'}>
        {sslStatus.toLowerCase()}
      </Badge>
    );
  };

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
          <h3 className="text-lg font-semibold mb-2">Error Loading Domains</h3>
          <p className="text-muted-foreground">Failed to load domains. Please try again.</p>
        </div>
      </div>
    );
  }

  const dialogContent = getDialogContent();

  return (
    <TooltipProvider>
      <div className="space-y-8 animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold bg-gradient-primary bg-clip-text text-transparent">
              Domains
            </h1>
            <p className="text-muted-foreground">
              Manage your custom domains and SSL certificates.
            </p>
          </div>
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
                  Connect an existing domain or register a new one through your registrar.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleAddDomain} className="space-y-6">
                <div className="space-y-3">
                  <Label className="text-sm">Domain type</Label>
                  <RadioGroup
                    className="grid grid-cols-1 md:grid-cols-2 gap-3"
                    value={addMode}
                    onValueChange={(value) => setAddMode(value as 'existing' | 'register')}
                  >
                    <div className="flex items-start space-x-3 rounded-md border border-border/60 bg-muted/40 p-3">
                      <RadioGroupItem value="existing" id="domain-mode-existing" />
                      <div className="space-y-1">
                        <Label htmlFor="domain-mode-existing">Use existing domain</Label>
                        <p className="text-xs text-muted-foreground">
                          Use a domain you already own and connect it to Cloudflare automatically.
                        </p>
                      </div>
                    </div>
                    <div className="flex items-start space-x-3 rounded-md border border-border/60 bg-muted/20 p-3">
                      <RadioGroupItem value="register" id="domain-mode-register" />
                      <div className="space-y-1">
                        <Label htmlFor="domain-mode-register">Register new domain</Label>
                        <p className="text-xs text-muted-foreground">
                          Mark this domain as new. Registration is handled externally or via RDASH.
                        </p>
                      </div>
                    </div>
                  </RadioGroup>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="new-domain-name">
                    Domain name
                  </Label>
                  <Input
                    id="new-domain-name"
                    placeholder="example.com"
                    value={newDomainName}
                    onChange={(e) => setNewDomainName(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="new-domain-redirect">
                    Redirect to (optional)
                  </Label>
                  <Input
                    id="new-domain-redirect"
                    placeholder="https://your-app.example.com"
                    value={newRedirectTo}
                    onChange={(e) => setNewRedirectTo(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    If set, HTTP traffic to this domain will be redirected to the target URL.
                  </p>
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
                    disabled={createDomain.isPending || !newDomainName.trim()}
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

        {/* Search */}
        <div className="flex items-center space-x-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search domains..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex items-center space-x-2 text-sm text-muted-foreground">
            <Globe className="h-4 w-4 text-primary" />
            <span>{filteredDomains.length} domains</span>
          </div>
        </div>

        {/* Domains Section */}
        <div className="space-y-6">
          {filteredDomains.length === 0 ? (
            <Card className="bg-gradient-card border-border/50">
              <CardContent className="flex flex-col items-center justify-center py-12">
                <Globe className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">No Domains Yet</h3>
                <p className="text-muted-foreground text-center max-w-md mb-4">
                  Get started by adding your first custom domain to the platform.
                </p>
                <Button
                  className="bg-gradient-primary"
                  onClick={() => setAddDialogOpen(true)}
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add Your First Domain
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Domain</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>SSL Status</TableHead>
                    <TableHead>SSL Expiry</TableHead>
                    <TableHead>Redirect To</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredDomains.map((domain) => (
                    <TableRow key={domain.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center space-x-2">
                          <Globe className="h-4 w-4 text-muted-foreground" />
                          <span>{domain.name}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center space-x-2">
                          {getStatusIcon(domain.status)}
                          {getStatusBadge(domain.status)}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center space-x-2">
                          {getSSLIcon(domain.sslStatus)}
                          {getSSLBadge(domain.sslStatus)}
                        </div>
                      </TableCell>
                      <TableCell>
                        {domain.sslExpiry 
                          ? new Date(domain.sslExpiry).toLocaleDateString()
                          : '-'
                        }
                      </TableCell>
                      <TableCell>
                        {domain.redirectTo ? (
                          <div className="flex items-center space-x-2">
                            <ExternalLink className="h-3 w-3 text-muted-foreground" />
                            <span className="text-sm text-muted-foreground">{domain.redirectTo}</span>
                          </div>
                        ) : (
                          '-'
                        )}
                      </TableCell>
                      <TableCell>
                        {new Date(domain.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center space-x-2">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setSelectedDomain(domain)}
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
                                className="h-8 w-8 p-0"
                              >
                                <Settings className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Domain settings</p>
                            </TooltipContent>
                          </Tooltip>

                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleDelete(domain.id, domain.name)}
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
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {/* Domain Details Dialog */}
        <Dialog open={!!selectedDomain} onOpenChange={() => setSelectedDomain(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Domain Details</DialogTitle>
              <DialogDescription>
                Detailed information about the domain configuration.
              </DialogDescription>
            </DialogHeader>
            {selectedDomain && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">Domain Name</label>
                    <p className="text-sm">{selectedDomain.name}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">Status</label>
                    <div className="flex items-center space-x-2 mt-1">
                      {getStatusIcon(selectedDomain.status)}
                      {getStatusBadge(selectedDomain.status)}
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">SSL Status</label>
                    <div className="flex items-center space-x-2 mt-1">
                      {getSSLIcon(selectedDomain.sslStatus)}
                      {getSSLBadge(selectedDomain.sslStatus)}
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">SSL Expiry</label>
                    <p className="text-sm">
                      {selectedDomain.sslExpiry 
                        ? new Date(selectedDomain.sslExpiry).toLocaleDateString()
                        : 'Not set'
                      }
                    </p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">Redirect To</label>
                    <p className="text-sm">
                      {selectedDomain.redirectTo || 'Not configured'}
                    </p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">Created</label>
                    <p className="text-sm">
                      {new Date(selectedDomain.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                
                {selectedDomain.dnsRecords && (
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">DNS Records</label>
                    <div className="mt-2 p-3 bg-muted rounded-md">
                      <pre className="text-xs overflow-auto">
                        {JSON.stringify(selectedDomain.dnsRecords, null, 2)}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Confirmation Dialog */}
        {confirmAction && dialogContent && (
          <AlertDialog open={!!confirmAction} onOpenChange={() => setConfirmAction(null)}>
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
                  disabled={deleteDomain.isPending || verifyDomain.isPending || renewSSL.isPending}
                  className={dialogContent.variant === 'destructive' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''}
                >
                  {deleteDomain.isPending || verifyDomain.isPending || renewSSL.isPending ? (
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
