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
import apiRequest from '@/lib/api';
import { t } from '@/lib/i18n';

type Provider = 'github' | 'gitlab';

type ProviderStatus = {
  clientId: string;
  hasSecret: boolean;
  oauthBase: string;
  apiBase: string;
  callbackUrl: string;
};

type GitOAuthStatus = Record<Provider, ProviderStatus>;

type GitOAuthForm = { provider: Provider; clientId: string; clientSecret: string; oauthBase: string; apiBase: string };

const QUERY_KEY = ['integrations', 'git-oauth'];
const NAMES: Record<Provider, string> = { github: 'GitHub', gitlab: 'GitLab' };

/** The OAuth apps users connect their GitHub and GitLab accounts through. */
export function GitOAuthSettingsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<GitOAuthForm | null>(null);

  const { data: status, isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => (await apiRequest<GitOAuthStatus>('/git-oauth')).data!,
  });

  const save = useMutation({
    mutationFn: async ({ provider, ...payload }: GitOAuthForm) =>
      (await apiRequest<GitOAuthStatus>(`/git-oauth/${provider}`, { method: 'PUT', body: JSON.stringify(payload) })).data!,
    onSuccess: (saved) => {
      queryClient.setQueryData(QUERY_KEY, saved);
      setForm(null);
      toast({ title: t('Git OAuth settings saved') });
    },
    onError: (error: Error) => toast({ title: t('Failed to save Git OAuth settings'), description: error.message, variant: 'destructive' }),
  });

  const edit = (provider: Provider) => {
    const current = status![provider];
    setForm({
      provider,
      clientId: current.clientId,
      clientSecret: '',
      oauthBase: current.oauthBase,
      apiBase: current.apiBase,
    });
  };

  return (
    <Card className="bg-gradient-card border-border/50">
      <CardHeader>
        <CardTitle>{t('Git OAuth apps')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {isLoading || !status ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          (Object.keys(NAMES) as Provider[]).map((provider) => {
            const s = status[provider];
            return (
              <div key={provider} className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{NAMES[provider]}</span>
                  <Badge variant={s.clientId && s.hasSecret ? 'default' : 'outline'}>
                    {s.clientId && s.hasSecret ? t('Configured') : t('Not configured')}
                  </Badge>
                </div>
                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                  <span className="text-muted-foreground">{t('Client ID')}</span>
                  <span className="font-mono break-all">{s.clientId || '—'}</span>
                  {provider === 'gitlab' && (
                    <>
                      <span className="text-muted-foreground">{t('OAuth URL')}</span>
                      <span className="font-mono break-all">{s.oauthBase}</span>
                      <span className="text-muted-foreground">{t('API URL')}</span>
                      <span className="font-mono break-all">{s.apiBase}</span>
                    </>
                  )}
                  <span className="text-muted-foreground">{t('Callback URL')}</span>
                  <span className="font-mono break-all">{s.callbackUrl}</span>
                </div>
                <Button size="sm" variant="outline" onClick={() => edit(provider)}>
                  {t('Edit')}
                </Button>
              </div>
            );
          })
        )}
      </CardContent>

      <Dialog open={!!form} onOpenChange={(open) => !open && setForm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form && `${NAMES[form.provider]} OAuth`}</DialogTitle>
            <DialogDescription>
              {t('Register an OAuth app with the callback URL below. The secret is stored encrypted. Leave the client ID blank to turn it off.')}
            </DialogDescription>
          </DialogHeader>
          {form && status && (
            <form
              id="git-oauth-settings"
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate(form);
              }}
            >
              <div className="space-y-1">
                <Label>{t('Callback URL')}</Label>
                <p className="font-mono text-xs break-all">{status[form.provider].callbackUrl}</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="git-oauth-id">{t('Client ID')}</Label>
                <Input
                  id="git-oauth-id"
                  autoComplete="off"
                  value={form.clientId}
                  onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="git-oauth-secret">{t('Client secret')}</Label>
                <Input
                  id="git-oauth-secret"
                  type="password"
                  autoComplete="off"
                  placeholder={status[form.provider].hasSecret ? t('Leave blank to keep the current one') : ''}
                  value={form.clientSecret}
                  onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
                />
              </div>
              {form.provider === 'gitlab' && (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="git-oauth-base">{t('OAuth URL')}</Label>
                    <Input
                      id="git-oauth-base"
                      type="url"
                      placeholder="https://gitlab.com/oauth"
                      value={form.oauthBase}
                      onChange={(e) => setForm({ ...form, oauthBase: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="git-oauth-api">{t('API URL')}</Label>
                    <Input
                      id="git-oauth-api"
                      type="url"
                      placeholder="https://gitlab.com/api/v4"
                      value={form.apiBase}
                      onChange={(e) => setForm({ ...form, apiBase: e.target.value })}
                    />
                    <p className="text-xs text-muted-foreground">{t('Change both for a self-hosted GitLab.')}</p>
                  </div>
                </>
              )}
            </form>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)} disabled={save.isPending}>
              {t('Cancel')}
            </Button>
            <Button type="submit" form="git-oauth-settings" disabled={save.isPending}>
              {save.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('Save changes')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
