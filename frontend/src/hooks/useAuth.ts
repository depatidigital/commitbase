import { useMutation, useQueryClient } from '@tanstack/react-query';
import { login, register, logout, LoginCredentials, RegisterCredentials } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';

export const useLogin = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: login,
    onSuccess: (data) => {
      toast({
        title: 'Success',
        description: 'Login successful',
      });
      queryClient.invalidateQueries({ queryKey: ['user'] });
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
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
        title: 'Success',
        description: 'Registration successful',
      });
      queryClient.invalidateQueries({ queryKey: ['user'] });
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
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
        title: 'Success',
        description: 'Logged out successfully',
      });
      queryClient.clear();
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive',
      });
    },
  });
}; 