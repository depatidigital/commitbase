import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useLogin } from '@/hooks/useAuth';
import { LoginCredentials } from '@/lib/auth';
import { isAuthenticated } from '@/lib/auth';
import { Loader2 } from 'lucide-react';
import { lang, setLang, t } from '@/lib/i18n';

const loginSchema = z.object({
  email: z.string().email(t('Invalid email address')),
  password: z.string().min(1, t('Password is required')),
});

type LoginForm = z.infer<typeof loginSchema>;

const Login = () => {
  const navigate = useNavigate();
  const login = useLogin();
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
  });

  // Check if user is already authenticated
  useEffect(() => {
    const checkAuth = () => {
      if (isAuthenticated()) {
        navigate('/');
      } else {
        setIsCheckingAuth(false);
      }
    };

    checkAuth();
  }, [navigate]);

  const onSubmit = async (data: LoginForm) => {
    try {
      const credentials: LoginCredentials = {
        email: data.email,
        password: data.password,
      };
      await login.mutateAsync(credentials);
      navigate('/');
    } catch (error) {
      // Error is handled by the mutation
    }
  };

  // Show loading while checking authentication
  if (isCheckingAuth) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/40">
        <div className="flex flex-col items-center space-y-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">{t('Checking authentication...')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-muted/40">
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
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold text-center">
            {t('Sign In')}
          </CardTitle>
          <CardDescription className="text-center">
            {t('Enter your credentials to access your dashboard')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">{t('Email')}</Label>
              <Input
                id="email"
                type="email"
                placeholder={t('Enter your email')}
                {...register('email')}
                className={errors.email ? 'border-red-500' : ''}
              />
              {errors.email && (
                <p className="text-sm text-red-500">{errors.email.message}</p>
              )}
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="password">{t('Password')}</Label>
              <Input
                id="password"
                type="password"
                placeholder={t('Enter your password')}
                {...register('password')}
                className={errors.password ? 'border-red-500' : ''}
              />
              {errors.password && (
                <p className="text-sm text-red-500">{errors.password.message}</p>
              )}
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={login.isPending}
            >
              {login.isPending ? t('Signing in...') : t('Sign In')}
            </Button>
          </form>

          <p className="mt-4 text-center text-sm text-muted-foreground">
            {t('Accounts are created by an administrator or through an organization invite link.')}
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

export default Login; 