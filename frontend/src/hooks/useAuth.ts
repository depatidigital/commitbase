import { useMutation, useQueryClient } from '@tanstack/react-query';
import { login, register, logout, LoginCredentials, RegisterCredentials } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import { t } from '@/lib/i18n';

export const useLogin = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: login,
    onSuccess: (data) => {
      toast({
        title: t('Success'),
        description: t('Login successful'),
      });
      queryClient.invalidateQueries({ queryKey: ['user'] });
    },
    onError: (error: Error) => {
      toast({
        title: t('Error'),
        description: error.message,
        variant: 'destructive',
      });
    },
  });
};

export const useRegister = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: register,
    onSuccess: (data) => {
      toast({
        title: t('Success'),
        description: t('Registration successful'),
      });
      queryClient.invalidateQueries({ queryKey: ['user'] });
    },
    onError: (error: Error) => {
      toast({
        title: t('Error'),
        description: error.message,
        variant: 'destructive',
      });
    },
  });
};

export const useLogout = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: () => {
      logout();
      return Promise.resolve();
    },
    onSuccess: () => {
      toast({
        title: t('Success'),
        description: t('Logged out successfully'),
      });
      queryClient.clear();
    },
    onError: (error: Error) => {
      toast({
        title: t('Error'),
        description: error.message,
        variant: 'destructive',
      });
    },
  });
}; 