import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  getDatabases, 
  getDatabase, 
  createDatabase, 
  updateDatabase, 
  deleteDatabase,
  type Database,
  type CreateDatabaseData,
  type UpdateDatabaseData
} from '@/lib/databases';
import { useToast } from '@/hooks/use-toast';
import { t } from '@/lib/i18n';

export const useDatabases = (applicationId: string, page = 1, limit = 10) => {
  return useQuery({
    queryKey: ['databases', applicationId, page, limit],
    queryFn: () => getDatabases(applicationId, page, limit),
    enabled: !!applicationId,
    staleTime: 30000, // 30 seconds
  });
};

export const useDatabase = (id: string) => {
  return useQuery({
    queryKey: ['database', id],
    queryFn: () => getDatabase(id),
    enabled: !!id,
    staleTime: 30000, // 30 seconds
  });
};

export const useCreateDatabase = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ applicationId, data }: { applicationId: string; data: CreateDatabaseData }) =>
      createDatabase({ ...data, applicationId }),
    onSuccess: (data, variables) => {
      toast({
        title: t('Success'),
        description: t('Database created successfully'),
      });
      queryClient.invalidateQueries({ queryKey: ['databases', variables.applicationId] });
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

export const useUpdateDatabase = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateDatabaseData }) =>
      updateDatabase(id, data),
    onSuccess: (data, variables) => {
      toast({
        title: t('Success'),
        description: t('Database updated successfully'),
      });
      queryClient.invalidateQueries({ queryKey: ['databases'] });
      queryClient.invalidateQueries({ queryKey: ['database', variables.id] });
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

export const useDeleteDatabase = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: (id: string) => deleteDatabase(id),
    onSuccess: (data, variables) => {
      toast({
        title: t('Success'),
        description: t('Database deleted successfully'),
      });
      queryClient.invalidateQueries({ queryKey: ['databases'] });
      queryClient.removeQueries({ queryKey: ['database', variables] });
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