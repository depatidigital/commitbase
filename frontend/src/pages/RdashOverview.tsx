import { useRdashSummary, useCloudflareZones, useRdashConfigStatus, useCloudflareConfigStatus, useUpdateRdashConfig, useUpdateCloudflareConfig } from '@/hooks/useRdash';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, Globe, Cloud, CreditCard, AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { useLocation } from 'react-router-dom';

const RdashOverview = () => {
  const { data: rdashConfig, isLoading: rdashConfigLoading } = useRdashConfigStatus();
  const { data: cloudflareConfig, isLoading: cloudflareConfigLoading } = useCloudflareConfigStatus();
  const [cloudflarePage, setCloudflarePage] = useState(1);
  const updateRdashConfig = useUpdateRdashConfig();
  const updateCloudflareConfig = useUpdateCloudflareConfig();
  const location = useLocation();
  const isCloudflarePage = location.pathname.includes('/integrations/cloudflare');

  const [rdashForm, setRdashForm] = useState({
    baseUrl: '',
    resellerId: '',
    apiKey: '',
  });

  const [cloudflareForm, setCloudflareForm] = useState({
    apiBase: '',
    apiToken: '',
  });

  const [rdashEditing, setRdashEditing] = useState(false);
  const [cloudflareEditing, setCloudflareEditing] = useState(false);

  const isRdashConfigured = !!(rdashConfig?.resellerIdSet && rdashConfig?.apiKeySet);
  const isCloudflareConfigured = !!cloudflareConfig?.apiTokenSet;

  const { data: summary, isLoading: summaryLoading } = useRdashSummary(!rdashConfigLoading && isRdashConfigured);
  const { data: cloudflareZones, isLoading: zonesLoading, refetch: refetchZones } = useCloudflareZones(cloudflarePage, 50, !cloudflareConfigLoading && isCloudflareConfigured);

  const balance = summary?.balance;
  const rdashDomains = summary?.domains;

  if (!isCloudflarePage) {
    return (
      <div className="max-w-6xl mx-auto space-y-8 animate-fade-in">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold bg-gradient-primary bg-clip-text text-transparent">
              RDASH Integration
            </h1>
            <p className="text-muted-foreground mt-1">
              RDASH registrar configuration and domain overview.
            </p>
          </div>
        </div>

        <Card className="bg-gradient-card border-border/50">
          <CardHeader>
            <CardTitle>RDASH configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {rdashConfigLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Checking RDASH configuration...</span>
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">RDASH</span>
                    <Badge variant={rdashConfig?.resellerIdSet && rdashConfig?.apiKeySet ? "default" : "outline"}>
                      {rdashConfig?.resellerIdSet && rdashConfig?.apiKeySet ? "Configured" : "Not configured"}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground space-y-1">
                    {!rdashEditing ? (
                      <>
                        <div>Base URL: {rdashConfig?.baseUrl}</div>
                        <div>Reseller ID: {rdashConfig?.resellerIdSet ? "set" : "not set"}</div>
                        <div>API key: {rdashConfig?.apiKeySet ? "set" : "not set"}</div>
                      </>
                    ) : (
                      <div className="space-y-2">
                        <Input
                          placeholder={rdashConfig?.baseUrl || 'https://api.rdash.id/v1'}
                          value={rdashForm.baseUrl}
                          onChange={(e) => setRdashForm(prev => ({ ...prev, baseUrl: e.target.value }))}
                        />
                        <Input
                          placeholder={rdashConfig?.resellerIdSet ? '••••••' : 'Reseller ID'}
                          value={rdashForm.resellerId}
                          onChange={(e) => setRdashForm(prev => ({ ...prev, resellerId: e.target.value }))}
                        />
                        <Input
                          placeholder={rdashConfig?.apiKeySet ? '••••••' : 'API key'}
                          value={rdashForm.apiKey}
                          onChange={(e) => setRdashForm(prev => ({ ...prev, apiKey: e.target.value }))}
                        />
                      </div>
                    )}
                  </div>
                  <div className="pt-3 flex gap-2">
                    {!rdashEditing ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setRdashForm({
                            baseUrl: '',
                            resellerId: '',
                            apiKey: '',
                          });
                          setRdashEditing(true);
                        }}
                      >
                        Edit
                      </Button>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setRdashEditing(false);
                            setRdashForm({
                              baseUrl: '',
                              resellerId: '',
                              apiKey: '',
                            });
                          }}
                          disabled={updateRdashConfig.isPending}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          className="bg-gradient-primary text-black hover:opacity-90"
                          onClick={async () => {
                            await updateRdashConfig.mutateAsync({
                              baseUrl: rdashForm.baseUrl || undefined,
                              resellerId: rdashForm.resellerId || undefined,
                              apiKey: rdashForm.apiKey || undefined,
                            });
                            setRdashEditing(false);
                            setRdashForm({
                              baseUrl: '',
                              resellerId: '',
                              apiKey: '',
                            });
                          }}
                          disabled={updateRdashConfig.isPending}
                        >
                          {updateRdashConfig.isPending && (
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          )}
                          Save changes
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  Changes here are saved directly to the CommitBase database and used by the backend services.
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {isRdashConfigured && (
          <>
            {summary?.errors && (
              <Card className="border-destructive/50 bg-destructive/5">
                <CardHeader className="flex flex-row items-center gap-2 space-y-0 pb-2">
                  <AlertTriangle className="h-4 w-4 text-destructive" />
                  <CardTitle className="text-sm font-medium text-destructive">
                    RDASH API errors
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1">
                  {Object.entries(summary.errors).map(([key, message]) => (
                    <div key={key} className="text-sm">
                      <span className="font-medium capitalize">{key}: </span>
                      <span className="text-muted-foreground">{message}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

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
            </div>

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
          </>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-8 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-primary bg-clip-text text-transparent">
            Cloudflare Integration
          </h1>
          <p className="text-muted-foreground mt-1">
            Cloudflare DNS configuration and zones overview.
          </p>
        </div>
      </div>

      <Card className="bg-gradient-card border-border/50">
        <CardHeader>
          <CardTitle>Cloudflare configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {cloudflareConfigLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Checking Cloudflare configuration...</span>
            </div>
          ) : (
            <>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-medium">Cloudflare</span>
                  <Badge variant={cloudflareConfig?.apiTokenSet ? "default" : "outline"}>
                    {cloudflareConfig?.apiTokenSet ? "Configured" : "Not configured"}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground space-y-1">
                  {!cloudflareEditing ? (
                    <>
                      <div>API base: {cloudflareConfig?.apiBase}</div>
                      <div>API token: {cloudflareConfig?.apiTokenSet ? "set" : "not set"}</div>
                    </>
                  ) : (
                    <div className="space-y-2">
                      <Input
                        placeholder={cloudflareConfig?.apiBase || 'https://api.cloudflare.com/client/v4'}
                        value={cloudflareForm.apiBase}
                        onChange={(e) => setCloudflareForm(prev => ({ ...prev, apiBase: e.target.value }))}
                      />
                      <Input
                        placeholder={cloudflareConfig?.apiTokenSet ? '••••••' : 'API token'}
                        value={cloudflareForm.apiToken}
                        onChange={(e) => setCloudflareForm(prev => ({ ...prev, apiToken: e.target.value }))}
                      />
                    </div>
                  )}
                </div>
                <div className="pt-3 flex gap-2">
                  {!cloudflareEditing ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setCloudflareForm({
                          apiBase: '',
                          apiToken: '',
                        });
                        setCloudflareEditing(true);
                      }}
                    >
                      Edit
                    </Button>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setCloudflareEditing(false);
                          setCloudflareForm({
                            apiBase: '',
                            apiToken: '',
                          });
                        }}
                        disabled={updateCloudflareConfig.isPending}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        className="bg-gradient-primary text-black hover:opacity-90"
                        onClick={async () => {
                          await updateCloudflareConfig.mutateAsync({
                            apiBase: cloudflareForm.apiBase || undefined,
                            apiToken: cloudflareForm.apiToken || undefined,
                          });
                          setCloudflareEditing(false);
                          setCloudflareForm({
                            apiBase: '',
                            apiToken: '',
                          });
                        }}
                        disabled={updateCloudflareConfig.isPending}
                      >
                        {updateCloudflareConfig.isPending && (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        )}
                        Save changes
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <div className="text-xs text-muted-foreground">
                Changes here are saved directly to the CommitBase database and used by the backend services.
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {isCloudflareConfigured && (
        <Card className="bg-gradient-card border-border/50">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Cloud className="h-4 w-4 text-primary" />
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
      )}
    </div>
  );
};

export default RdashOverview;
