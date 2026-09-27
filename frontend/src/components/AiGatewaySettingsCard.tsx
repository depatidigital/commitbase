import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, Pause, Play, Plus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Column, DataTable, useTableQuery } from '@/components/DataTable';
import { OrganizationCombobox } from '@/components/OrganizationCombobox';
import { useToast } from '@/hooks/use-toast';
import { creditWallet, fromMicro, getAiGatewayConfig, getWallets, rupiah, saveAiGatewayConfig, setAiSuspended, type AiGatewayConfig, type WalletRow } from '@/lib/ai';
import { t } from '@/lib/i18n';

type Form = { baseUrl: string; adminKey: string; adminPath: string; rate: string; markup: string; optimaMarkup: string };

const QUERY_KEY = ['integrations', 'ai-gateway'];

/** The AI gateway's URL and management key, and how its buy prices are sold: rate × markup. */
export function AiGatewaySettingsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Form | null>(null);
  const { data: status, isLoading } = useQuery({ queryKey: QUERY_KEY, queryFn: getAiGatewayConfig });

  const save = useMutation({
    mutationFn: saveAiGatewayConfig,
    onSuccess: (saved: AiGatewayConfig) => {
      queryClient.setQueryData(QUERY_KEY, saved);
      setForm(null);
      toast(
        saved.check
          ? { title: t('Saved, but the gateway refused the call'), description: saved.check, variant: 'destructive' }
          : { title: t('AI gateway settings saved') },
      );
    },
    onError: (error: Error) => toast({ title: t('Failed to save the AI gateway settings'), description: error.message, variant: 'destructive' }),
  });

  const perDollar = status ? status.rate * status.markup : 0;

  return (
    <Card className="bg-gradient-card border-border/50">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>AI Gateway</span>
          <Badge variant={status?.adminKeySet ? 'default' : 'outline'}>{status?.adminKeySet ? t('Configured') : t('Not configured')}</Badge>
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
              <span className="text-muted-foreground">{t('Admin key')}</span>
              <span>{status?.adminKeySet ? t('Set') : '—'}</span>
              <span className="text-muted-foreground">{t('Admin path')}</span>
              <span>{status?.adminPathSet ? t('Set') : '—'}</span>
              <span className="text-muted-foreground">{t('Rate')}</span>
              <span className="tabular-nums">{rupiah(status?.rate ?? 0)} / USD</span>
              <span className="text-muted-foreground">{t('Markup')}</span>
              <span className="tabular-nums">
                × {status?.markup} = {rupiah(perDollar)} {t('per dollar bought')}
              </span>
              <span className="text-muted-foreground">larika-optima</span>
              <span className="tabular-nums">
                × {status?.optimaMarkup} = {rupiah((status?.rate ?? 0) * (status?.optimaMarkup ?? 0))} {t('per dollar bought')}
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => status && setForm({ baseUrl: status.baseUrl, adminKey: '', adminPath: '', rate: String(status.rate), markup: String(status.markup), optimaMarkup: String(status.optimaMarkup) })}
            >
              {t('Edit')}
            </Button>
            {status?.baseUrl && (
              <Button size="sm" variant="outline" className="ml-2" asChild>
                {/* providers, their keys and models' buy prices are set there */}
                <a href={`${status.baseUrl}/dashboard/`} target="_blank" rel="noreferrer">
                  {t('Providers & models')} <ExternalLink className="ml-1 h-3.5 w-3.5" />
                </a>
              </Button>
            )}
          </>
        )}
      </CardContent>

      <Dialog open={!!form} onOpenChange={(open) => !open && setForm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>AI Gateway</DialogTitle>
            <DialogDescription>{t("The gateway's ADMIN_KEY is stored encrypted. Saving checks it with one call to the gateway.")}</DialogDescription>
          </DialogHeader>
          {form && (
            <form
              id="ai-gateway-settings"
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate({ baseUrl: form.baseUrl, adminKey: form.adminKey, adminPath: form.adminPath, rate: Number(form.rate), markup: Number(form.markup), optimaMarkup: Number(form.optimaMarkup) });
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="ai-url">URL</Label>
                <Input id="ai-url" className="font-mono" placeholder="https://ai.larika.id" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ai-key">{t('Admin key')}</Label>
                <Input
                  id="ai-key"
                  type="password"
                  autoComplete="off"
                  className="font-mono"
                  placeholder={status?.adminKeySet ? t('Leave blank to keep the current one') : 'ADMIN_KEY'}
                  value={form.adminKey}
                  onChange={(e) => setForm({ ...form, adminKey: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ai-path">
                  {t('Admin path')} <span className="text-muted-foreground">{t('(optional)')}</span>
                </Label>
                <Input
                  id="ai-path"
                  type="password"
                  autoComplete="off"
                  className="font-mono"
                  placeholder={status?.adminPathSet ? t('Leave blank to keep the current one') : 'ADMIN_SECRET_PATH'}
                  value={form.adminPath}
                  onChange={(e) => setForm({ ...form, adminPath: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="ai-rate">{t('Rate (IDR per USD)')}</Label>
                  <Input id="ai-rate" type="number" required min={1000} step="1" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ai-markup">{t('Markup')}</Label>
                  <Input id="ai-markup" type="number" required min={1} step="0.001" value={form.markup} onChange={(e) => setForm({ ...form, markup: e.target.value })} />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="ai-optima-markup">{t('larika-optima markup')}</Label>
                <Input id="ai-optima-markup" type="number" required min={1} step="0.001" value={form.optimaMarkup} onChange={(e) => setForm({ ...form, optimaMarkup: e.target.value })} />
                <p className="text-xs text-muted-foreground">{t("For turns the router picked, and only out of what they saved: never above the cheapest top model at the normal markup, never below the model that ran. Caps use the higher of the two markups.")}</p>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('Every call is charged its buy price × rate × markup: {price} per dollar bought. Changing either moves every workspace\'s spend cap at once.', {
                  price: rupiah((Number(form.rate) || 0) * (Number(form.markup) || 0)),
                })}
              </p>
            </form>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)} disabled={save.isPending}>
              {t('Cancel')}
            </Button>
            <Button type="submit" form="ai-gateway-settings" disabled={save.isPending}>
              {save.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('Save changes')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** Every workspace's balance; credit one by hand (the beta's top-up, and corrections); suspend its AI API. */
export function WalletsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = useTableQuery(10);
  const { data = [], isFetching } = useQuery({ queryKey: ['wallets'], queryFn: getWallets });
  const [crediting, setCrediting] = useState<{ organizationId: string | null; amount: string; note: string } | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['wallets'] });

  const credit = useMutation({
    mutationFn: creditWallet,
    onSuccess: () => {
      setCrediting(null);
      refresh();
      toast({ title: t('Balance updated') });
    },
    onError: (error: Error) => toast({ title: t('Failed to credit the wallet'), description: error.message, variant: 'destructive' }),
  });
  const suspend = useMutation({
    mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) => setAiSuspended(id, disabled),
    onSuccess: (_r, v) => toast({ title: v.disabled ? t('AI API suspended') : t('AI API resumed') }),
    onError: (error: Error) => toast({ title: t('Failed to change the AI API'), description: error.message, variant: 'destructive' }),
  });

  const columns: Column<WalletRow>[] = [
    { header: t('Workspace'), cell: (w) => <span className="font-medium">{w.name}</span> },
    { header: t('Balance'), className: 'text-right', cell: (w) => <span className={`tabular-nums ${fromMicro(w.balance) <= 0 ? 'text-destructive' : ''}`}>{rupiah(fromMicro(w.balance))}</span> },
    { header: t('AI API'), cell: (w) => (w.aiAccountId ? t('On') : '—') },
    {
      header: '',
      className: 'w-48 text-right',
      cell: (w) => (
        <div className="flex justify-end gap-1">
          <Button variant="outline" size="sm" onClick={() => setCrediting({ organizationId: w.organizationId, amount: '', note: '' })}>
            {t('Credit')}
          </Button>
          {w.aiAccountId && (
            <>
              <Button variant="ghost" size="sm" aria-label={t('Suspend')} title={t('Suspend')} onClick={() => suspend.mutate({ id: w.organizationId, disabled: true })}>
                <Pause className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" aria-label={t('Resume')} title={t('Resume')} onClick={() => suspend.mutate({ id: w.organizationId, disabled: false })}>
                <Play className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('Workspace balances')}</CardTitle>
      </CardHeader>
      <CardContent>
        <DataTable
          columns={columns}
          rows={data}
          rowKey={(w) => w.organizationId}
          query={query}
          filter={(w, search) => w.name.toLowerCase().includes(search.toLowerCase())}
          isLoading={isFetching && !data.length}
          searchPlaceholder={t('Search workspaces…')}
          empty={t('No balances yet.')}
          toolbar={
            <Button size="sm" onClick={() => setCrediting({ organizationId: null, amount: '', note: '' })}>
              <Plus className="mr-2 h-4 w-4" /> {t('Credit a workspace')}
            </Button>
          }
        />
      </CardContent>

      <Dialog open={!!crediting} onOpenChange={(o) => !o && setCrediting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Credit a workspace')}</DialogTitle>
            <DialogDescription>{t('Rupiah added to its balance (negative takes it back). The note shows on its statement.')}</DialogDescription>
          </DialogHeader>
          {crediting && (
            <form
              id="credit-wallet"
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (crediting.organizationId) credit.mutate({ organizationId: crediting.organizationId, amount: Number(crediting.amount), note: crediting.note });
              }}
            >
              <div className="space-y-1">
                <Label>{t('Workspace')}</Label>
                <OrganizationCombobox value={crediting.organizationId} onChange={(organizationId) => setCrediting({ ...crediting, organizationId })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="credit-amount">{t('Amount (Rp)')}</Label>
                <Input id="credit-amount" type="number" required step="1" value={crediting.amount} onChange={(e) => setCrediting({ ...crediting, amount: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="credit-note">{t('Note')}</Label>
                <Input id="credit-note" required maxLength={200} placeholder={t('e.g. Top-up by bank transfer, 27 Sep')} value={crediting.note} onChange={(e) => setCrediting({ ...crediting, note: e.target.value })} />
              </div>
            </form>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCrediting(null)} disabled={credit.isPending}>
              {t('Cancel')}
            </Button>
            <Button type="submit" form="credit-wallet" disabled={credit.isPending || !crediting?.organizationId}>
              {credit.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
