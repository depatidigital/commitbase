import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Column, DataTable, useTableQuery } from '@/components/DataTable';
import { topUpDate, topUpStatus } from '@/components/TopUpDialog';
import { useToast } from '@/hooks/use-toast';
import { checkTopUpsNow, getAllTopUps, getArusniagaConfig, saveArusniagaConfig, type ArusniagaConfig, type TopUp } from '@/lib/arusniaga';
import { fromMicro, rupiah } from '@/lib/ai';
import { t } from '@/lib/i18n';

const QUERY_KEY = ['integrations', 'arusniaga'];

/** ArusNiaga's URL and API key: where Larika's invoices (top-ups) are issued. */
export function ArusniagaSettingsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<{ baseUrl: string; apiKey: string } | null>(null);
  const { data: status, isLoading } = useQuery({ queryKey: QUERY_KEY, queryFn: getArusniagaConfig });

  const save = useMutation({
    mutationFn: saveArusniagaConfig,
    onSuccess: (saved: ArusniagaConfig) => {
      queryClient.setQueryData(QUERY_KEY, saved);
      setForm(null);
      toast(saved.error ? { title: t('Saved, but ArusNiaga refused the call'), description: saved.error, variant: 'destructive' } : { title: t('ArusNiaga settings saved') });
    },
    onError: (error: Error) => toast({ title: t('Failed to save the ArusNiaga settings'), description: error.message, variant: 'destructive' }),
  });

  const connected = status?.apiKeySet && !status.error;
  return (
    <Card className="bg-gradient-card border-border/50">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>ArusNiaga</span>
          <Badge variant={connected ? 'default' : 'outline'}>{connected ? t('Connected') : status?.apiKeySet ? t('Not reachable') : t('Not configured')}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <>
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <span className="text-muted-foreground">URL</span>
              <span className="font-mono break-all">{status?.baseUrl || '—'}</span>
              <span className="text-muted-foreground">{t('API key')}</span>
              <span>{status?.apiKeySet ? t('Set') : '—'}</span>
              <span className="text-muted-foreground">{t('Invoices as')}</span>
              <span>{status?.business ?? (status?.error ? <span className="text-destructive">{status.error}</span> : '—')}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setForm({ baseUrl: status?.baseUrl ?? '', apiKey: '' })}>
                {t('Edit')}
              </Button>
              {status?.baseUrl && (
                <Button size="sm" variant="outline" asChild>
                  {/* API keys: Admin → Pengaturan → API Keys there */}
                  <a href={`${status.baseUrl}/admin`} target="_blank" rel="noreferrer">
                    {t('Open ArusNiaga')} <ExternalLink className="ml-1 h-3.5 w-3.5" />
                  </a>
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={!!form} onOpenChange={(open) => !open && setForm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ArusNiaga</DialogTitle>
            <DialogDescription>{t('An API key from ArusNiaga (Admin → Pengaturan → API Keys), scoped to the business that invoices. Stored encrypted; saving checks it with one call.')}</DialogDescription>
          </DialogHeader>
          {form && (
            <form
              id="arusniaga-settings"
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate(form);
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="arusniaga-url">URL</Label>
                <Input id="arusniaga-url" className="font-mono" placeholder="https://erp.depatidigital.com" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="arusniaga-key">{t('API key')}</Label>
                <Input
                  id="arusniaga-key"
                  type="password"
                  autoComplete="off"
                  className="font-mono"
                  placeholder={status?.apiKeySet ? t('Leave blank to keep the current one') : 'X-API-Key'}
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                />
              </div>
            </form>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)} disabled={save.isPending}>
              {t('Cancel')}
            </Button>
            <Button type="submit" form="arusniaga-settings" disabled={save.isPending}>
              {save.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('Save changes')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** Every workspace's top-ups; "check now" asks ArusNiaga about the unpaid ones at once. */
export function TopUpsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = useTableQuery(10);
  const { data = [], isFetching } = useQuery({ queryKey: ['topups', 'all'], queryFn: getAllTopUps });
  const check = useMutation({
    mutationFn: checkTopUpsNow,
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ['topups', 'all'] });
      toast({ title: t('Checked'), description: r.summary });
    },
    onError: (error: Error) => toast({ title: t('The check failed'), description: error.message, variant: 'destructive' }),
  });

  const columns: Column<TopUp & { userName: string }>[] = [
    { header: t('Created'), cell: (x) => topUpDate(x.createdAt) },
    { header: t('User'), cell: (x) => <span className="font-medium">{x.userName}</span> },
    { header: t('Invoice'), cell: (x) => (x.invoiceUrl ? <a href={x.invoiceUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">{x.invoiceRef ?? t('Open')}</a> : x.invoiceRef ?? '—') },
    { header: t('Amount'), className: 'text-right', cell: (x) => <span className="tabular-nums">{rupiah(fromMicro(x.amount))}</span> },
    { header: t('Status'), cell: (x) => <span className={x.status === 'PAID' ? 'text-success' : x.status === 'PENDING' ? '' : 'text-muted-foreground'}>{topUpStatus(x.status)}</span> },
    { header: t('Paid'), cell: (x) => topUpDate(x.paidAt) },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('Top-ups')}</CardTitle>
      </CardHeader>
      <CardContent>
        <DataTable
          columns={columns}
          rows={data}
          rowKey={(x) => x.id}
          query={query}
          filter={(x, search) => `${x.userName} ${x.invoiceRef ?? ''} ${x.status}`.toLowerCase().includes(search.toLowerCase())}
          isLoading={isFetching && !data.length}
          searchPlaceholder={t('Search users…')}
          empty={t('No top-ups yet.')}
          toolbar={
            <Button size="sm" variant="outline" onClick={() => check.mutate()} disabled={check.isPending}>
              <RefreshCw className={`mr-2 h-4 w-4 ${check.isPending ? 'animate-spin' : ''}`} /> {t('Check payments now')}
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}
