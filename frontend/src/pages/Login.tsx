import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useLogin, useRegister } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import apiRequest, { setAuthToken } from '@/lib/api';
import { isAuthenticated } from '@/lib/auth';
import { APP_NAME } from '@/lib/branding';
import { lang, setLang, t } from '@/lib/i18n';

declare global {
  interface Window {
    google?: any;
  }
}

/**
 * Google's own button (Google Identity Services). It hands us an ID token,
 * the backend checks it and signs in — or signs up — that email.
 * Renders nothing while the backend has no GOOGLE_CLIENT_ID.
 */
function GoogleButton({ text }: { text: 'signin_with' | 'signup_with' }) {
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: clientId } = useQuery({
    queryKey: ['auth-providers'],
    queryFn: async () =>
      (await apiRequest<{ googleClientId: string | null }>('/auth/providers')).data?.googleClientId ?? null,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!clientId) return;
    const render = () => {
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async ({ credential }: { credential: string }) => {
          try {
            const res = await apiRequest<{ token: string }>('/auth/google', {
              method: 'POST',
              body: JSON.stringify({ credential }),
            });
            setAuthToken(res.data!.token);
            navigate('/');
          } catch (error) {
            toast({ title: t('Error'), description: (error as Error).message, variant: 'destructive' });
          }
        },
      });
      window.google.accounts.id.renderButton(ref.current, {
        text,
        size: 'large',
        width: ref.current?.offsetWidth,
        locale: lang,
      });
    };
    if (window.google?.accounts) return render();
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = render;
    document.head.appendChild(script);
  }, [clientId, text, navigate, toast]);

  if (!clientId) return null;
  return (
    <>
      <div ref={ref} className="flex h-10 w-full justify-center" />
      <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
        <div className="h-px flex-1 bg-border" />
        {t('or')}
        <div className="h-px flex-1 bg-border" />
      </div>
    </>
  );
}

/** Sign in (/login) and sign up (/register): one page, Google first, email as the fallback. */
const Login = ({ mode = 'login' }: { mode?: 'login' | 'register' }) => {
  const navigate = useNavigate();
  const login = useLogin();
  const signup = useRegister();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const isRegister = mode === 'register';
  const pending = login.isPending || signup.isPending;

  if (isAuthenticated()) return <Navigate to="/" replace />;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (isRegister) await signup.mutateAsync({ name, email, password });
      else await login.mutateAsync({ email, password });
      navigate('/');
    } catch {
      // the mutation shows the error
    }
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-muted/40 p-4">
      {/* language: a reload applies it, see lib/i18n */}
      <div className="absolute right-4 top-4 flex items-center rounded-full border border-border p-0.5 text-xs font-medium">
        {(["id", "en"] as const).map((code) => (
          <button
            key={code}
            type="button"
            onClick={() => setLang(code)}
            aria-pressed={lang === code}
            className={`rounded-full px-2 py-0.5 uppercase transition-colors ${
              lang === code ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {code}
          </button>
        ))}
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-1 text-center">
          <img src="/favicon.svg" alt="" className="mx-auto mb-2 h-10 w-10" />
          <CardTitle className="text-2xl font-bold">
            {isRegister ? t('Create your account') : t('Sign In')}
          </CardTitle>
          <CardDescription>
            {isRegister ? t('Start using {app} in a minute', { app: APP_NAME }) : t('Welcome back to {app}', { app: APP_NAME })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <GoogleButton text={isRegister ? 'signup_with' : 'signin_with'} />

          <form onSubmit={onSubmit} className="space-y-4">
            {isRegister && (
              <div className="space-y-2">
                <Label htmlFor="name">{t('Name')}</Label>
                <Input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">{t('Email')}</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">{t('Password')}</Label>
                {!isRegister && (
                  <Link to="/forgot-password" className="text-xs text-muted-foreground hover:text-primary hover:underline">
                    {t('Forgot password?')}
                  </Link>
                )}
              </div>
              <Input
                id="password"
                type="password"
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                minLength={isRegister ? 8 : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? t('Please wait...') : isRegister ? t('Sign up') : t('Sign In')}
            </Button>
          </form>

          <p className="mt-4 text-center text-sm text-muted-foreground">
            {isRegister ? t('Already have an account?') : t("Don't have an account?")}{' '}
            <Link to={isRegister ? '/login' : '/register'} className="font-medium text-primary hover:underline">
              {isRegister ? t('Sign In') : t('Sign up')}
            </Link>
          </p>

          {isRegister && (
            <p className="mt-4 text-center text-xs text-muted-foreground">
              {t('By signing up you agree to the')}{' '}
              <Link to="/terms" target="_blank" className="underline hover:text-primary">
                {t('Terms of Service')}
              </Link>{' '}
              {t('and')}{' '}
              <Link to="/privacy" target="_blank" className="underline hover:text-primary">
                {t('Privacy Policy')}
              </Link>
              .
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default Login;
