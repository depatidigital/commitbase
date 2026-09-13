import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import apiRequest from '@/lib/api';
import { t } from '@/lib/i18n';

type GoogleStatus = {
  clientEmail: string;
  owners: string;
  /** after a save: null when the key gets a Google token, else why not */
  check?: string | null;
};

type GoogleForm = { serviceAccount: string; owners: string };

const QUERY_KEY = ['integrations', 'google-search-console'];

/** The Google service account that verifies domains and adds them to Search Console. */
export function SearchConsoleSettingsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<GoogleForm | null>(null);

  const { data: status, isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => (await apiRequest<GoogleStatus>('/google/search-console')).data!,
  });

  const save = useMutation({
    mutationFn: async (payload: GoogleForm) =>
      (await apiRequest<GoogleStatus>('/google/search-console', { method: 'PUT', body: JSON.stringify(payload) })).data!,
    onSuccess: (saved) => {
      queryClient.setQueryData(QUERY_KEY, saved);
      setForm(null);
      toast(
        saved.check
          ? { title: t('Saved, but Google refused the key'), description: saved.check, variant: 'destructive' }
          : { title: t('Search Console settings saved') }
      );
    },
    onError: (error: Error) => toast({ title: t('Failed to save Search Console settings'), description: error.message, variant: 'destructive' }),
  });

  const configured = !!status?.clientEmail;

  return (
    <Card className="bg-gradient-card border-border/50">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Google Search Console</span>
          <Badge variant={configured ? 'default' : 'outline'}>{configured ? t('Configured') : t('Not configured')}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <>
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <span className="text-muted-foreground">{t('Service account')}</span>
              <span className="font-mono break-all">{status?.clientEmail || '—'}</span>
              <span className="text-muted-foreground">{t('Default owners')}</span>
              <span className="font-mono break-all">{status?.owners || '—'}</span>
            </div>
            <Button size="sm" variant="outline" onClick={() => setForm({ serviceAccount: '', owners: status?.owners ?? '' })}>
              {t('Edit')}
            </Button>
          </>
        )}
      </CardContent>

      <Dialog open={!!form} onOpenChange={(open) => !open && setForm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Google Search Console</DialogTitle>
            <DialogDescription>
              {t('A Google Cloud service account key (JSON) from a project with the Site Verification API and the Google Search Console API enabled. The key is stored encrypted.')}
            </DialogDescription>
          </DialogHeader>
          {form && (
            <form
              id="google-settings"
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate(form);
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="google-key">{t('Service account key')}</Label>
                <Textarea
                  id="google-key"
                  rows={5}
                  className="font-mono text-xs"
                  autoComplete="off"
                  placeholder={configured ? t('Leave blank to keep the current one') : '{ "type": "service_account", ... }'}
                  value={form.serviceAccount}
                  onChange={(e) => setForm({ ...form, serviceAccount: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="google-owners">{t('Default owners')}</Label>
                <Input
                  id="google-owners"
                  placeholder="you@gmail.com"
                  value={form.owners}
                  onChange={(e) => setForm({ ...form, owners: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  {t('Google accounts given owner access to every domain added, so it shows in their Search Console.')}
                </p>
              </div>
            </form>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)} disabled={save.isPending}>
              {t('Cancel')}
            </Button>
            <Button type="submit" form="google-settings" disabled={save.isPending}>
              {save.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('Save changes')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
