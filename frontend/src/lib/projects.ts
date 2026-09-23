import apiRequest, { PaginatedResponse } from './api';
import { type ListParams, listQuery } from './admin';
import { t } from './i18n';
import type { AppBranches } from './applications';

/**
 * Projects ("Proyek") — the API's sources: a repository checkout or an upload,
 * and the apps ("Aplikasi") served from it. Pulling and deploying are the
 * project's; everything per hostname stays on the app.
 */

export type ProjectStatus = 'RUNNING' | 'PARTIAL' | 'STOPPED' | 'ERROR' | 'DEPLOYING' | 'DISABLED' | 'EMPTY';

export interface ProjectApp {
  id: string;
  name: string;
  /** its hostnames, all alike */
  domains: Array<{ host: string; path?: string; domainId: string | null }>;
  type: string;
  status: string;
  runtime: string | null;
  disabled: boolean;
  processName: string | null;
  rootDirectory: string | null;
  rootPath: string | null;
  port: number | null;
  /** a hostname split by path: `/api/*` → the app, the rest → static files */
  routing: Array<{ path: string | null; proxy?: string; root?: string }> | null;
  createdAt: string;
  /** bytes on disk (or in R2), null until measured */
  diskBytes: number | null;
  diskMeasuredAt: string | null;
  /** its migrations, run before each build; the deploy confirmation can leave it out */
  preDeployCommand: string | null;
}

export interface Project {
  id: string;
  /** what to show: its own name, else derived (repository, folder, first hostname) */
  name: string;
  /** the name someone gave it; null = derived */
  customName: string | null;
  /** IMPORTED: checked out on its server, pulled there. MANAGED: built and deployed by the panel. */
  kind: 'IMPORTED' | 'MANAGED';
  status: ProjectStatus;
  repository: string | null;
  branch: string | null;
  gitAccountId: string | null;
  /** imported: the checkout on its server */
  path: string | null;
  organization: { id: string; name: string; slug: string } | null;
  server: { id: string; name: string; hostname?: string; publicIp?: string } | null;
  applications: ProjectApp[];
  /** detail only: the caller may switch an imported checkout's branch (its org's owner/admin, a platform admin) */
  canSwitchBranch?: boolean;
  /** detail only: the caller may delete it and manage its members (its creator, its org's owner/admin) */
  canManage?: boolean;
  activeRelease?: { id: string; commitSha: string | null; createdAt: string } | null;
  lastDeployment?: { status: string; createdAt: string; commitHash: string | null; commitMessage: string | null } | null;
  createdAt: string;
}

export const getProjects = async (
  params: ListParams & { serverId?: string },
): Promise<PaginatedResponse<Project>> => {
  const { serverId, ...rest } = params;
  const query = listQuery(rest);
  const extra = serverId ? `${query ? '&' : '?'}serverId=${encodeURIComponent(serverId)}` : '';
  const response = await apiRequest<PaginatedResponse<Project>>(`/sources${query}${extra}`);
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Could not load the apps'));
};

export interface ProjectUser {
  id: string;
  name: string | null;
  email: string;
}

/** Who sees a project. Org owners/admins always do and can't be removed. */
export interface ProjectMembers {
  admins: Array<ProjectUser & { role: 'OWNER' | 'ADMIN' }>;
  creator: ProjectUser | null;
  members: Array<ProjectUser & { addedAt: string }>;
  /** org members who could be added (empty unless canManage) */
  candidates: ProjectUser[];
  canManage: boolean;
}

export const getProjectMembers = async (id: string): Promise<ProjectMembers> => {
  const response = await apiRequest<ProjectMembers>(`/sources/${id}/members`);
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Could not load the members'));
};

export const addProjectMember = async (id: string, userId: string): Promise<void> => {
  const response = await apiRequest(`/sources/${id}/members`, { method: 'POST', body: JSON.stringify({ userId }) });
  if (!response.success) throw new Error(response.error || t('Could not add the member'));
};

export const removeProjectMember = async (id: string, userId: string): Promise<void> => {
  const response = await apiRequest(`/sources/${id}/members/${userId}`, { method: 'DELETE' });
  if (!response.success) throw new Error(response.error || t('Could not remove the member'));
};

export const getProject = async (id: string): Promise<Project> => {
  const response = await apiRequest<Project>(`/sources/${id}`);
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Could not load the app'));
};

export const updateProject = async (
  id: string,
  data: Partial<{ name: string; repository: string; branch: string; gitAccountId: string | null; organizationId: string | null }>,
): Promise<Project> => {
  const response = await apiRequest<Project>(`/sources/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Could not update the app'));
};

/** Branches, their newest commits, and what is live. */
export const getProjectBranches = async (id: string): Promise<AppBranches> => {
  const response = await apiRequest<AppBranches>(`/sources/${id}/branches`);
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Could not read the branches'));
};

/** git pull of an imported project's checkout — for every app served from it. */
export const pullProject = async (id: string): Promise<{ output: string; apps: string[] }> => {
  const response = await apiRequest<{ output: string; apps: string[] }>(`/sources/${id}/pull`, { method: 'POST' });
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Pull failed'));
};

/** Switch an imported project's checkout to another branch, on its server — for every app served from it. */
/** `consent`: the user ticked that the sites run the new branch at once — the API refuses without it. */
export const checkoutProject = async (id: string, branch: string, consent: boolean): Promise<{ output: string; apps: string[] }> => {
  const response = await apiRequest<{ output: string; apps: string[] }>(`/sources/${id}/checkout`, { method: 'POST', body: JSON.stringify({ branch, consent }) });
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t('Could not switch the branch'));
};

/** Build every imported app of a project where it lives, one after the other. `consent`: the user ticked that the sites may err meanwhile. */
export const buildProject = async (id: string, consent: boolean): Promise<string[]> => {
  const response = await apiRequest<{ apps: string[] }>(`/sources/${id}/build`, { method: 'POST', body: JSON.stringify({ consent }) });
  if (response.success && response.data) return response.data.apps;
  throw new Error(response.error || t('Could not start the build'));
};

/** Build and release every app of a panel-managed project. */
/** `skipPreDeployFor`: the apps whose pre-deploy step (migrations) is left out this once. */
export const deployProject = async (id: string, skipPreDeployFor: string[] = []): Promise<string> => {
  const response = await apiRequest<{ deploymentId: string }>(`/sources/${id}/deploy`, {
    method: 'POST',
    ...(skipPreDeployFor.length > 0 && { body: JSON.stringify({ skipPreDeployFor }) }),
  });
  if (response.success && response.data) return response.data.deploymentId;
  throw new Error(response.error || t('Could not start the deployment'));
};

/** Give projects (and every app of them) an owner. */
export const assignProjects = async (ids: string[], organizationId: string | null): Promise<number> => {
  const response = await apiRequest<{ count: number }>('/applications/bulk-assign', {
    method: 'PATCH',
    body: JSON.stringify({ ids, organizationId, sources: true }),
  });
  if (response.success && response.data) return response.data.count;
  throw new Error(response.error || t('Failed to assign services'));
};

export const PROJECT_STATUS: Record<ProjectStatus, { dot: string; text: string }> = {
  RUNNING: { dot: "bg-success", text: t("All running") },
  PARTIAL: { dot: "bg-warning", text: t("Some stopped") },
  STOPPED: { dot: "bg-muted-foreground/40", text: t("Stopped") },
  ERROR: { dot: "bg-destructive ring-4 ring-destructive/15", text: t("Needs attention") },
  DEPLOYING: { dot: "", text: t("Deploying") },
  DISABLED: { dot: "bg-muted-foreground/20", text: t("Disabled") },
  EMPTY: { dot: "bg-muted-foreground/20", text: t("No services") },
};

/**
 * An app as the list shows it: one row per path its hostname is split into —
 * `app.arusflow.id` (the static front end) and `app.arusflow.id/api/*` (the
 * API) — else one row. `main` is the hostname itself: the part its uptime
 * check reaches. `owner`: the part the app's own process (its port) serves.
 */
export type AppPart = {
  key: string;
  label: string;
  type: string;
  /** what serves it: `:9200`, or the folder of static files */
  proxyPort: number | null;
  root: string | null;
  main: boolean;
  owner: boolean;
};

export function appParts(app: ProjectApp): AppPart[] {
  // a split is the same on every name of the app: shown once, under its first
  const first = app.domains[0]?.host ?? app.name;
  const host = first.endsWith(".local") ? app.name : first;
  if (!app.routing?.length) {
    return [{ key: app.id, label: host, type: app.type, proxyPort: app.port, root: null, main: true, owner: true }];
  }
  // the hostname first, then its paths, in the order Caddy tries them
  const parts = [...app.routing].sort((a, b) => Number(a.path !== null) - Number(b.path !== null));
  return parts.map((part, index) => {
    const port = Number(part.proxy?.match(/:(\d+)$/)?.[1]) || null;
    return {
      key: `${app.id}:${index}`,
      label: part.path ? `${host}${part.path}` : host,
      type: part.proxy ? "NODEJS" : "STATIC",
      proxyPort: port,
      root: part.root ?? null,
      main: part.path === null,
      owner: port !== null && port === app.port,
    };
  });
}

/** Where a project goes: always its own page — its apps are opened from there. */
export const projectPath = (project: Pick<Project, "id">) => `/project/${project.id}`;
