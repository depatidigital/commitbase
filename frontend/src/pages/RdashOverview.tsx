import { useRdashSummary, useCloudflareZones, useRdashConfigStatus, useCloudflareConfigStatus, useUpdateRdashConfig, useUpdateCloudflareConfig } from '@/hooks/useRdash';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, Globe, Cloud, CreditCard, AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { APP_NAME } from '@/lib/branding';
import { t } from '@/lib/i18n';
import { R2SettingsCard } from '@/components/R2SettingsCard';

// RDash /domains returns status as an int enum plus status_label/status_badge (swagger v1).
const RDASH_STATUS_LABEL: Record<number, string> = {
  0: t('Pending'),
  1: t('Active'),
  2: t('Expired'),
  3: t('Pending Delete'),
  4: t('Deleted'),
  5: t('Pending Transfer'),
  6: t('Transferred Away'),
  7: t('Suspended'),
  8: t('Rejected'),
};

const RDASH_BADGE_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  success: 'default',
  danger: 'destructive',
  warning: 'secondary',
  secondary: 'secondary',
};

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
              {t('RDASH Integration')}
            </h1>
            <p className="text-muted-foreground mt-1">
              {t('RDASH registrar configuration and domain overview.')}
            </p>
          </div>
        </div>

        <Card className="bg-gradient-card border-border/50">
          <CardHeader>
            <CardTitle>{t('RDASH configuration')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {rdashConfigLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{t('Checking RDASH configuration...')}</span>
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">RDASH</span>
                    <Badge variant={rdashConfig?.resellerIdSet && rdashConfig?.apiKeySet ? "default" : "outline"}>
                      {rdashConfig?.resellerIdSet && rdashConfig?.apiKeySet ? t('Configured') : t('Not configured')}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground space-y-1">
                    {!rdashEditing ? (
                      <>
                        <div>{t('Base URL: {url}', { url: rdashConfig?.baseUrl ?? '' })}</div>
                        <div>{rdashConfig?.resellerIdSet ? t('Reseller ID: set') : t('Reseller ID: not set')}</div>
                        <div>{rdashConfig?.apiKeySet ? t('API key: set') : t('API key: not set')}</div>
                      </>
                    ) : (
                      <div className="space-y-2">
                        <Input
                          placeholder={rdashConfig?.baseUrl || 'https://api.rdash.id/v1'}
                          value={rdashForm.baseUrl}
                          onChange={(e) => setRdashForm(prev => ({ ...prev, baseUrl: e.target.value }))}
                        />
                        <Input
                          placeholder={rdashConfig?.resellerIdSet ? '••••••' : t('Reseller ID')}
                          value={rdashForm.resellerId}
                          onChange={(e) => setRdashForm(prev => ({ ...prev, resellerId: e.target.value }))}
                        />
                        <Input
                          placeholder={rdashConfig?.apiKeySet ? '••••••' : t('API key')}
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
                        {t('Edit')}
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
                          {t('Cancel')}
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
                          {t('Save changes')}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  {t('Changes here are saved directly to the {appName} database and used by the backend services.', { appName: APP_NAME })}
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
                    {t('RDASH API errors')}
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
                    {t('RDash Balance')}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {summaryLoading ? (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>{t('Loading...')}</span>
                    </div>
                  ) : (
                    <div className="text-2xl font-bold">
                      {balance !== null && balance !== undefined
                        ? Number(balance).toLocaleString('id-ID', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })
                        : '-'}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="bg-gradient-card border-border/50">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Globe className="h-4 w-4 text-primary" />
                    {t('RDash Domains')}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {summaryLoading ? (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>{t('Loading...')}</span>
                    </div>
                  ) : (
                    <div className="text-2xl font-bold">
                      {/* meta.total is the account-wide count; data is only the current page */}
                      {(rdashDomains as any)?.meta?.total ??
                        (Array.isArray((rdashDomains as any)?.data)
                          ? (rdashDomains as any).data.length
                          : Array.isArray(rdashDomains)
                          ? (rdashDomains as any).length
                          : '-')}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card className="bg-gradient-card border-border/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Globe className="h-5 w-5 text-primary" />
                  {t('RDash Domains')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {summaryLoading ? (
                  <div className="flex items-center justify-center h-32 text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin mr-2" /> {t('Loading RDash domains...')}
                  </div>
                ) : !rdashDomains ? (
                  <div className="text-sm text-muted-foreground">
                    {t('No RDash domain data available.')}
                  </div>
                ) : (
                  <div className="border rounded-md overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('Name')}</TableHead>
                          <TableHead>{t('Status')}</TableHead>
                          <TableHead>{t('Expiry')}</TableHead>
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
                              <Badge variant={RDASH_BADGE_VARIANT[domain.status_badge] ?? 'outline'}>
                                {domain.status_label ||
                                  RDASH_STATUS_LABEL[domain.status] ||
                                  domain.state ||
                                  t('UNKNOWN')}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {domain.expired_at || domain.expiryDate || domain.expire_date || '-'}
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
            {t('Cloudflare Integration')}
          </h1>
          <p className="text-muted-foreground mt-1">
            {t('Cloudflare DNS configuration and zones overview.')}
          </p>
        </div>
      </div>

      <Card className="bg-gradient-card border-border/50">
        <CardHeader>
          <CardTitle>{t('Cloudflare configuration')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {cloudflareConfigLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>{t('Checking Cloudflare configuration...')}</span>
            </div>
          ) : (
            <>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-medium">Cloudflare</span>
                  <Badge variant={cloudflareConfig?.apiTokenSet ? "default" : "outline"}>
                    {cloudflareConfig?.apiTokenSet ? t('Configured') : t('Not configured')}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground space-y-1">
                  {!cloudflareEditing ? (
                    <>
                      <div>{t('API base: {url}', { url: cloudflareConfig?.apiBase ?? '' })}</div>
                      <div>{cloudflareConfig?.apiTokenSet ? t('API token: set') : t('API token: not set')}</div>
                    </>
                  ) : (
                    <div className="space-y-2">
                      <Input
                        placeholder={cloudflareConfig?.apiBase || 'https://api.cloudflare.com/client/v4'}
                        value={cloudflareForm.apiBase}
                        onChange={(e) => setCloudflareForm(prev => ({ ...prev, apiBase: e.target.value }))}
                      />
                      <Input
                        placeholder={cloudflareConfig?.apiTokenSet ? '••••••' : t('API token')}
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
                      {t('Edit')}
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
                        {t('Cancel')}
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
                        {t('Save changes')}
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <div className="text-xs text-muted-foreground">
                {t('Changes here are saved directly to the {appName} database and used by the backend services.', { appName: APP_NAME })}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <R2SettingsCard />

      {isCloudflareConfigured && (
        <Card className="bg-gradient-card border-border/50">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Cloud className="h-4 w-4 text-primary" />
              {t('Cloudflare Zones')}
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetchZones()}
              disabled={zonesLoading}
            >
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              {t('Refresh')}
            </Button>
          </CardHeader>
          <CardContent>
            {zonesLoading ? (
              <div className="flex items-center justify-center h-32 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin mr-2" /> {t('Loading Cloudflare zones...')}
              </div>
            ) : !cloudflareZones || cloudflareZones.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                {t('No Cloudflare zones found for this API token.')}
              </div>
            ) : (
              <div className="border rounded-md overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('Zone')}</TableHead>
                      <TableHead>{t('Status')}</TableHead>
                      <TableHead>{t('Type')}</TableHead>
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
                            {zone.status || t('unknown')}
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
