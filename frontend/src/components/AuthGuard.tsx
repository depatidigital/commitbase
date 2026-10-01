import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { isAuthenticated, getCurrentUser, removeAuthToken, validateUserToken } from '@/lib/auth';
import { Loader2 } from 'lucide-react';
import { t } from '@/lib/i18n';
import { getOrganizations } from '@/lib/organizations';
import { MINE } from '@/components/OrgSwitcher';
import Onboarding from '@/pages/Onboarding';
import VerifyEmail from '@/pages/VerifyEmail';
import apiRequest from '@/lib/api';

interface AuthGuardProps {
  children: React.ReactNode;
}

export function AuthGuard({ children }: AuthGuardProps) {
  const navigate = useNavigate();
  const [isValidating, setIsValidating] = useState(true);
  const ready = !isValidating && isAuthenticated();
  // email not confirmed yet → the wait screen; refetched on tab focus, so clicking the link elsewhere lets them in
  const me = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: async () =>
      (await apiRequest<{ user: { email: string; emailVerifiedAt: string | null } }>('/auth/validate')).data!.user,
    enabled: ready,
  });
  const verified = !!me.data?.emailVerifiedAt;
  // the switcher's own list (same key): no workspace yet → onboarding before the panel
  const orgs = useQuery({ queryKey: MINE, queryFn: getOrganizations, enabled: ready && verified });

  useEffect(() => {
    const validateUser = async () => {
      try {
        // First check local authentication
        if (!isAuthenticated()) {
          removeAuthToken();
          navigate('/login');
          return;
        }

        // Get current user from token
        const currentUser = getCurrentUser();
        if (!currentUser) {
          removeAuthToken();
          navigate('/login');
          return;
        }

        // Validate token with backend (optional - can be disabled for performance)
        try {
          const isValid = await validateUserToken();
          if (!isValid) {
            removeAuthToken();
            navigate('/login');
            return;
          }
        } catch (error) {
          console.warn('Backend validation failed, continuing with local validation:', error);
          // Continue with local validation if backend is unavailable
        }
      } catch (error) {
        console.error('Error during user validation:', error);
        removeAuthToken();
        navigate('/login');
      } finally {
        // must clear on every path, redirects included, or the spinner sticks
        setIsValidating(false);
      }
    };

    // Run validation on component mount
    validateUser();
  }, [navigate]);

  // Show loading spinner while validating
  if (isValidating || me.isLoading || orgs.isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div role="status" className="flex flex-col items-center space-y-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">{t('Validating user session...')}</p>
        </div>
      </div>
    );
  }

  if (me.data && !verified) return <VerifyEmail email={me.data.email} />;
  if (orgs.data?.length === 0) return <Onboarding queryKey={MINE} />;

  return <>{children}</>;
} 