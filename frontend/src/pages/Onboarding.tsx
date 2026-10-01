import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { createOrganization, type Organization } from '@/lib/organizations';
import { setActiveOrg } from '@/lib/api';
import { useLogout } from '@/hooks/useAuth';
import { t } from '@/lib/i18n';

/**
 * Shown by AuthGuard to anyone in no workspace yet (new sign-up, an account an
 * admin made, someone who left their last one): name the first one to go on.
 */
export default function Onboarding({ queryKey }: { queryKey: string[] }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const logout = useLogout();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => createOrganization({ name: name.trim() }),
    onSuccess: (workspace) => {
      setActiveOrg(workspace.id);
      // the guard and the switcher read this list: filling it lets the panel in
      queryClient.setQueryData<Organization[]>(queryKey, [workspace]);
    },
    onError: (err: Error) => toast({ title: t('Failed to create workspace'), description: err.message, variant: 'destructive' }),
  });

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-1 text-center">
          <img src="/favicon.svg" alt="" className="mx-auto mb-2 h-10 w-10" />
          <CardTitle className="text-2xl font-bold">{t('Create your workspace')}</CardTitle>
          <CardDescription>
            {t('One per client or business: its own apps, domains, databases and team. You can add more later.')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim().length >= 2) create.mutate();
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="workspace">{t('Workspace name')}</Label>
              <Input
                id="workspace"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('e.g. Warung Kopi Senja')}
                required
                minLength={2}
              />
            </div>
            <Button type="submit" className="w-full" disabled={name.trim().length < 2 || create.isPending}>
              {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('Continue')}
            </Button>
          </form>
          <button
            type="button"
            onClick={() => logout.mutate()}
            className="mt-4 w-full text-center text-sm text-muted-foreground hover:underline"
          >
            {t('Sign out')}
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
