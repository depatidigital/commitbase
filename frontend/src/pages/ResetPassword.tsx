import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import apiRequest, { setAuthToken } from '@/lib/api';
import { t } from '@/lib/i18n';

/**
 * /forgot-password asks for the email and mails a link; the link opens
 * /reset-password?token=…, which sets the new password and signs in.
 */
export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const navigate = useNavigate();
  const { toast } = useToast();
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    try {
      if (token) {
        const res = await apiRequest<{ token: string }>('/auth/reset-password', {
          method: 'POST',
          body: JSON.stringify({ token, password: value }),
        });
        setAuthToken(res.data!.token);
        toast({ title: t('Password updated') });
        navigate('/');
      } else {
        await apiRequest('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: value }) });
        setSent(true);
      }
    } catch (error) {
      toast({ title: t('Error'), description: (error as Error).message, variant: 'destructive' });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-1 text-center">
          <img src="/favicon.svg" alt="" className="mx-auto mb-2 h-10 w-10" />
          <CardTitle className="text-2xl font-bold">{token ? t('Choose a new password') : t('Forgot password')}</CardTitle>
          <CardDescription>
            {token
              ? t('At least 8 characters.')
              : sent
                ? t('If that email has an account, a reset link is on its way. Check your inbox and spam folder.')
                : t("Enter your account's email and we will send you a link to reset your password.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!sent && (
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="value">{token ? t('New password') : t('Email')}</Label>
                <Input
                  id="value"
                  type={token ? 'password' : 'email'}
                  autoComplete={token ? 'new-password' : 'email'}
                  minLength={token ? 8 : undefined}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoFocus
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={pending}>
                {pending ? t('Please wait...') : token ? t('Save password') : t('Send reset link')}
              </Button>
            </form>
          )}
          <p className="mt-4 text-center text-sm">
            <Link to="/login" className="font-medium text-primary hover:underline">
              {t('Back to sign in')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
