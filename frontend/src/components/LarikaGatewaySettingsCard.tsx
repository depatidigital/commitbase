import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { getGatewayConfig, saveGatewayConfig, type GatewayConfig } from '@/lib/waGateway';
import { t } from '@/lib/i18n';

type Form = { baseUrl: string; adminKey: string; adminPath: string };

const QUERY_KEY = ['integrations', 'larika-gateway'];

/** The WhatsApp gateway's URL and management key: what WA Node and every workspace's numbers go through. */
export function LarikaGatewaySettingsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Form | null>(null);

  const { data: status, isLoading } = useQuery({ queryKey: QUERY_KEY, queryFn: getGatewayConfig });

  const save = useMutation({
    mutationFn: saveGatewayConfig,
    onSuccess: (saved: GatewayConfig) => {
      queryClient.setQueryData(QUERY_KEY, saved);
      setForm(null);
      toast(
        saved.check
          ? { title: t('Saved, but the gateway refused the call'), description: saved.check, variant: 'destructive' }
          : { title: t('Gateway settings saved') },
      );
    },
    onError: (error: Error) => toast({ title: t('Failed to save gateway settings'), description: error.message, variant: 'destructive' }),
  });

  return (
    <Card className="bg-gradient-card border-border/50">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Larika Gateway</span>
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
            </div>
            <Button size="sm" variant="outline" onClick={() => setForm({ baseUrl: status?.baseUrl ?? '', adminKey: '', adminPath: '' })}>
              {t('Edit')}
            </Button>
          </>
        )}
      </CardContent>

      <Dialog open={!!form} onOpenChange={(open) => !open && setForm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Larika Gateway</DialogTitle>
            <DialogDescription>{t("The gateway's ADMIN_KEY, stored encrypted. Saving checks it with one call to the gateway.")}</DialogDescription>
          </DialogHeader>
          {form && (
            <form
              id="gateway-settings"
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate(form);
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="gateway-url">URL</Label>
                <Input id="gateway-url" className="font-mono" placeholder="https://gateway.larika.id" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="gateway-key">{t('Admin key')}</Label>
                <Input
                  id="gateway-key"
                  type="password"
                  autoComplete="off"
                  className="font-mono"
                  placeholder={status?.adminKeySet ? t('Leave blank to keep the current one') : 'ADMIN_KEY'}
                  value={form.adminKey}
                  onChange={(e) => setForm({ ...form, adminKey: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="gateway-path">
                  {t('Admin path')} <span className="text-muted-foreground">{t('(optional)')}</span>
                </Label>
                <Input
                  id="gateway-path"
                  type="password"
                  autoComplete="off"
                  className="font-mono"
                  placeholder={status?.adminPathSet ? t('Leave blank to keep the current one') : 'ADMIN_SECRET_PATH'}
                  value={form.adminPath}
                  onChange={(e) => setForm({ ...form, adminPath: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  {t("The gateway only takes management calls from IPs in its ADMIN_IP_ALLOWLIST. Add this panel's IP there, or set its ADMIN_SECRET_PATH here instead.")}
                </p>
              </div>
            </form>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)} disabled={save.isPending}>
              {t('Cancel')}
            </Button>
            <Button type="submit" form="gateway-settings" disabled={save.isPending}>
              {save.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('Save changes')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
