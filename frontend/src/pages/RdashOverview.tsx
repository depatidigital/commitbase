import { useRdashSummary, useCloudflareZones, useRdashConfigStatus, useCloudflareConfigStatus } from '@/hooks/useRdash';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, Globe, Cloud, CreditCard } from 'lucide-react';
import { useState } from 'react';

const RdashOverview = () => {
  const { data: summary, isLoading: summaryLoading } = useRdashSummary();
  const { data: rdashConfig, isLoading: rdashConfigLoading } = useRdashConfigStatus();
  const { data: cloudflareConfig, isLoading: cloudflareConfigLoading } = useCloudflareConfigStatus();
  const [cloudflarePage, setCloudflarePage] = useState(1);
  const { data: cloudflareZones, isLoading: zonesLoading, refetch: refetchZones } = useCloudflareZones(cloudflarePage, 50);

  const balance = summary?.balance;
  const rdashDomains = summary?.domains;

  return (
    <div className="max-w-6xl mx-auto space-y-8 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-primary bg-clip-text text-transparent">
            Domain Integrations
          </h1>
          <p className="text-muted-foreground mt-1">
            RDash registrar and Cloudflare DNS overview & configuration helper
          </p>
        </div>
      </div>

      <Card className="bg-gradient-card border-border/50">
        <CardHeader>
          <CardTitle>Integration configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {rdashConfigLoading || cloudflareConfigLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Checking RDASH and Cloudflare configuration...</span>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">RDASH</span>
                    <Badge variant={rdashConfig?.resellerIdSet && rdashConfig?.apiKeySet ? "default" : "outline"}>
                      {rdashConfig?.resellerIdSet && rdashConfig?.apiKeySet ? "Configured" : "Not configured"}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground space-y-1">
                    <div>Base URL: {rdashConfig?.baseUrl}</div>
                    <div>Reseller ID: {rdashConfig?.resellerIdSet ? "set" : "not set"}</div>
                    <div>API key: {rdashConfig?.apiKeySet ? "set" : "not set"}</div>
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">Cloudflare</span>
                    <Badge variant={cloudflareConfig?.apiTokenSet && cloudflareConfig?.zoneIdSet && cloudflareConfig?.dnsTargetSet ? "default" : "outline"}>
                      {cloudflareConfig?.apiTokenSet && cloudflareConfig?.zoneIdSet && cloudflareConfig?.dnsTargetSet ? "Configured" : "Not configured"}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground space-y-1">
                    <div>API base: {cloudflareConfig?.apiBase}</div>
                    <div>Zone ID: {cloudflareConfig?.zoneIdSet ? "set" : "not set"}</div>
                    <div>DNS target: {cloudflareConfig?.dnsTargetSet ? "set" : "not set"}</div>
                  </div>
                </div>
              </div>
              <div className="text-xs text-muted-foreground">
                These values are stored in the CommitBase database and controlled from this integration menu.
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="bg-gradient-card border-border/50">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-primary" />
              RDash Balance
            </CardTitle>
          </CardHeader>
          <CardContent>
            {summaryLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Loading...</span>
              </div>
            ) : (
              <div className="text-2xl font-bold">
                {balance !== null && balance !== undefined ? balance : '-'}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-gradient-card border-border/50">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Globe className="h-4 w-4 text-primary" />
              RDash Domains
            </CardTitle>
          </CardHeader>
          <CardContent>
            {summaryLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Loading...</span>
              </div>
            ) : (
              <div className="text-2xl font-bold">
                {Array.isArray((rdashDomains as any)?.data)
                  ? (rdashDomains as any).data.length
                  : Array.isArray(rdashDomains)
                  ? (rdashDomains as any).length
                  : '-'}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-gradient-card border-border/50">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Cloud className="h-4 w-4 text-primary" />
              Cloudflare Zones
            </CardTitle>
          </CardHeader>
          <CardContent>
            {zonesLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Loading...</span>
              </div>
            ) : (
              <div className="text-2xl font-bold">
                {Array.isArray(cloudflareZones) ? cloudflareZones.length : '-'}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="bg-gradient-card border-border/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-5 w-5 text-primary" />
              RDash Domains
            </CardTitle>
          </CardHeader>
          <CardContent>
            {summaryLoading ? (
              <div className="flex items-center justify-center h-32 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading RDash domains...
              </div>
            ) : !rdashDomains ? (
              <div className="text-sm text-muted-foreground">
                No RDash domain data available.
              </div>
            ) : (
              <div className="border rounded-md overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Expiry</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(Array.isArray((rdashDomains as any)?.data)
                      ? (rdashDomains as any).data
                      : Array.isArray(rdashDomains)
                      ? rdashDomains
                      : []
                    ).map((domain: any) => (
                      <TableRow key={domain.id || domain.domain || domain.name}>
                        <TableCell className="font-medium">
                          {domain.domain || domain.name || '-'}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {domain.status || domain.state || 'UNKNOWN'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {domain.expiryDate || domain.expire_date || domain.expired_at || '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-gradient-card border-border/50">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Cloud className="h-5 w-5 text-primary" />
              Cloudflare Zones
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetchZones()}
              disabled={zonesLoading}
            >
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Refresh
            </Button>
          </CardHeader>
          <CardContent>
            {zonesLoading ? (
              <div className="flex items-center justify-center h-32 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading Cloudflare zones...
              </div>
            ) : !cloudflareZones || cloudflareZones.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No Cloudflare zones found for this API token.
              </div>
            ) : (
              <div className="border rounded-md overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Zone</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Type</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cloudflareZones.map((zone: any) => (
                      <TableRow key={zone.id}>
                        <TableCell className="font-medium">
                          {zone.name}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {zone.status || 'unknown'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {zone.type || zone.plan?.name || '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default RdashOverview;
