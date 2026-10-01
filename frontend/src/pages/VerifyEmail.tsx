import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { useLogout } from '@/hooks/useAuth';
import apiRequest from '@/lib/api';
import { t } from '@/lib/i18n';

/**
 * /verify-email?token=… confirms the address from the mailed link. Without a
 * token it is the wait screen AuthGuard shows an unconfirmed account: resend,
 * or check again once they clicked the link (it also rechecks on tab focus).
 */
export default function VerifyEmail({ email }: { email?: string }) {
  const [params] = useSearchParams();
  const token = params.get('token');
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const logout = useLogout();
  const [state, setState] = useState<'checking' | 'done' | 'failed'>('checking');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const sent = useRef(false);

  useEffect(() => {
    // once: StrictMode runs effects twice in dev
    if (!token || sent.current) return;
    sent.current = true;
    apiRequest('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) })
      .then(() => {
        setState('done');
        void queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
      })
      .catch((err: Error) => {
        setError(err.message);
        setState('failed');
      });
  }, [token, queryClient]);

  const resend = async () => {
    setPending(true);
    try {
      await apiRequest('/auth/resend-verification', { method: 'POST' });
      toast({ title: t('Email sent'), description: email });
    } catch (err) {
      toast({ title: t('Error'), description: (err as Error).message, variant: 'destructive' });
    } finally {
      setPending(false);
    }
  };

  const title = token
    ? state === 'checking'
      ? t('Confirming your email...')
      : state === 'done'
        ? t('Email confirmed')
        : t('Could not confirm your email')
    : t('Confirm your email');

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm text-center">
        <CardHeader className="space-y-1">
          <span className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            {token && state === 'checking' ? <Loader2 className="h-5 w-5 animate-spin" /> : <MailCheck className="h-5 w-5" />}
          </span>
          <CardTitle className="text-2xl font-bold">{title}</CardTitle>
          <CardDescription>
            {token
              ? state === 'done'
                ? t('Your welcome credit is in your balance.')
                : state === 'failed'
                  ? error
                  : null
              : t('We sent a link to {email}. Open it to start. Check your spam folder too.', { email: email ?? '' })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {token ? (
            state !== 'checking' && (
              <Button asChild className="w-full">
                <Link to="/">{t('Go to the panel')}</Link>
              </Button>
            )
          ) : (
            <>
              <Button className="w-full" onClick={() => queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })}>
                {t("I've confirmed it")}
              </Button>
              <Button variant="outline" className="w-full" onClick={resend} disabled={pending}>
                {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('Send the link again')}
              </Button>
              <button
                type="button"
                onClick={() => logout.mutate()}
                className="pt-2 text-sm text-muted-foreground hover:underline"
              >
                {t('Sign out')}
              </button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
