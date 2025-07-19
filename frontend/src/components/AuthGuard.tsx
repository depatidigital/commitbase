import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { isAuthenticated, getCurrentUser, removeAuthToken, validateUserToken } from '@/lib/auth';
import { Loader2 } from 'lucide-react';

interface AuthGuardProps {
  children: React.ReactNode;
}

export function AuthGuard({ children }: AuthGuardProps) {
  const navigate = useNavigate();
  const [isValidating, setIsValidating] = useState(true);

  useEffect(() => {
    const validateUser = async () => {
      try {
        // First check local authentication
        if (!isAuthenticated()) {
          console.log('User not authenticated locally, redirecting to login');
          removeAuthToken();
          navigate('/login');
          return;
        }

        // Get current user from token
        const currentUser = getCurrentUser();
        if (!currentUser) {
          console.log('Invalid user data locally, redirecting to login');
          removeAuthToken();
          navigate('/login');
          return;
        }

        // Validate token with backend (optional - can be disabled for performance)
        try {
          const isValid = await validateUserToken();
          if (!isValid) {
            console.log('Token invalid on backend, redirecting to login');
            removeAuthToken();
            navigate('/login');
            return;
          }
        } catch (error) {
          console.warn('Backend validation failed, continuing with local validation:', error);
          // Continue with local validation if backend is unavailable
        }

        console.log('User validation successful');
        setIsValidating(false);
      } catch (error) {
        console.error('Error during user validation:', error);
        removeAuthToken();
        navigate('/login');
      }
    };

    // Run validation on component mount
    validateUser();
  }, [navigate]);

  // Show loading spinner while validating
  if (isValidating) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center space-y-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Validating user session...</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
} 