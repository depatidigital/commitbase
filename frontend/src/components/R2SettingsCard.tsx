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

type R2Status = {
  accountId: string;
  accessKeyId: string;
  secretAccessKeySet: boolean;
  bucket: string;
  publicUrl: string;
  rootDir: string;
  /** after a save: null when the key reaches the bucket, else why not */
  check?: string | null;
};

type R2Form = Omit<R2Status, 'secretAccessKeySet' | 'check'> & { secretAccessKey: string };

const QUERY_KEY = ['integrations', 'r2-config'];

const FIELDS: Array<{ key: keyof R2Form; label: string; placeholder: string }> = [
  { key: 'accountId', label: 'Account ID', placeholder: 'af837a9648e33d7dad50eb3af312edbb' },
  { key: 'accessKeyId', label: 'Access key ID', placeholder: '' },
  { key: 'secretAccessKey', label: 'Secret access key', placeholder: '' },
  { key: 'bucket', label: 'Bucket', placeholder: 'my-bucket' },
  { key: 'publicUrl', label: 'Public URL', placeholder: 'https://cdn.example.com' },
  { key: 'rootDir', label: 'Root folder', placeholder: 'larika' },
];

/**
 * Where static sites are stored: one R2 bucket, each site a folder under
 * `<root folder>/<domain>/`, served through the bucket's public URL.
 */
export function R2SettingsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<R2Form | null>(null);

  const { data: status, isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => (await apiRequest<R2Status>('/cloudflare/r2')).data!,
  });

  const save = useMutation({
    mutationFn: async (payload: R2Form) =>
      (await apiRequest<R2Status>('/cloudflare/r2', { method: 'PUT', body: JSON.stringify(payload) })).data!,
    onSuccess: (saved) => {
      queryClient.setQueryData(QUERY_KEY, saved);
      setForm(null);
      toast(
        saved.check
          ? { title: t('Saved, but R2 is not reachable'), description: saved.check, variant: 'destructive' }
          : { title: t('R2 settings saved'), description: t('The key can reach the bucket.') }
      );
    },
    onError: (error: Error) => toast({ title: t('Failed to save R2 settings'), description: error.message, variant: 'destructive' }),
  });

  const configured = !!(status?.accountId && status?.accessKeyId && status?.secretAccessKeySet);
  const openForm = () =>
    setForm({
      accountId: status?.accountId ?? '',
      accessKeyId: status?.accessKeyId ?? '',
      // never sent back; blank keeps the stored one
      secretAccessKey: '',
      bucket: status?.bucket ?? '',
      publicUrl: status?.publicUrl ?? '',
      rootDir: status?.rootDir ?? '',
    });

  return (
    <Card className="bg-gradient-card border-border/50">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>{t('Cloudflare R2 storage')}</span>
          <Badge variant={configured ? 'default' : 'outline'}>{configured ? t('Configured') : t('Not configured')}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {t('Static sites are uploaded here, each into its own folder: {path}', {
                path: `${status?.bucket || '<bucket>'}/${status?.rootDir ? status.rootDir + '/' : ''}<domain>/`,
              })}
            </p>
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <span className="text-muted-foreground">{t('Bucket')}</span>
              <span className="font-mono break-all">{status?.bucket || '—'}</span>
              <span className="text-muted-foreground">{t('Public URL')}</span>
              <span className="font-mono break-all">{status?.publicUrl || '—'}</span>
              <span className="text-muted-foreground">{t('Root folder')}</span>
              <span className="font-mono break-all">{status?.rootDir || '—'}</span>
              <span className="text-muted-foreground">{t('Secret access key')}</span>
              <span>{status?.secretAccessKeySet ? t('set') : t('not set')}</span>
            </div>
            <Button size="sm" variant="outline" onClick={openForm}>
              {t('Edit')}
            </Button>
          </>
        )}
      </CardContent>

      <Dialog open={!!form} onOpenChange={(open) => !open && setForm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Cloudflare R2 storage')}</DialogTitle>
            <DialogDescription>
              {t('An R2 API token with Object Read & Write on the bucket. The secret is stored encrypted.')}
            </DialogDescription>
          </DialogHeader>
          {form && (
            <form
              id="r2-settings"
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate(form);
              }}
            >
              {FIELDS.map(({ key, label, placeholder }) => (
                <div key={key} className="space-y-1">
                  <Label htmlFor={`r2-${key}`}>{t(label)}</Label>
                  <Input
                    id={`r2-${key}`}
                    type={key === 'secretAccessKey' ? 'password' : 'text'}
                    autoComplete="off"
                    placeholder={key === 'secretAccessKey' && status?.secretAccessKeySet ? t('Leave blank to keep the current one') : placeholder}
                    value={form[key]}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  />
                </div>
              ))}
            </form>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)} disabled={save.isPending}>
              {t('Cancel')}
            </Button>
            <Button type="submit" form="r2-settings" disabled={save.isPending}>
              {save.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('Save changes')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
