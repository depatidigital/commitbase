import apiRequest from './api';
import { t } from './i18n';

type Commit = { sha: string | null; label: string; subject?: string; date?: string };

/** Larika itself: what runs, what is new on main, and the log of the last update (superadmin). */
export type SystemUpdate =
  | { supported: false }
  | {
      supported: true;
      branch: string;
      /** origin of /opt/larika/repo — where updates are pulled from */
      repo: string | null;
      /** the panel user's SSH public key, to add as a deploy key on a private repo */
      sshKey: string | null;
      current: Commit | null;
      previous: Commit | null;
      latest: string | null;
      pending: Array<{ sha: string; subject: string; author: string; date: string }>;
      running: boolean;
      log: string;
    };

export const getSystemUpdate = async (fetchRemote = false): Promise<SystemUpdate> => {
  const response = await apiRequest<SystemUpdate>(`/system/update${fetchRemote ? '?fetch=1' : ''}`);
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Could not read the update status'));
};

export const startSystemUpdate = async (action: 'update' | 'rollback'): Promise<void> => {
  const response = await apiRequest('/system/update', { method: 'POST', body: JSON.stringify({ action }) });
  if (!response.success) throw new Error(response.error || t('Could not start the update'));
};

export const setSystemUpdateRepo = async (url: string): Promise<void> => {
  const response = await apiRequest('/system/update/repo', { method: 'POST', body: JSON.stringify({ url }) });
  if (!response.success) throw new Error(response.error || t('Could not change the repository'));
};
