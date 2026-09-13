import apiRequest, { API_BASE_URL, PaginatedResponse } from './api';
import { type ListParams, listQuery } from './admin';
import { t } from './i18n';

export interface Application {
  /** The node it was discovered on, when it came from a server sync. */
  server?: { id: string; name: string } | null;
  id: string;
  name: string;
  domain: string;
  type: 'NODEJS' | 'STATIC' | 'PYTHON' | 'GO' | 'RUST' | 'PHP' | 'JAVA';
  status: 'RUNNING' | 'STOPPED' | 'ERROR' | 'DEPLOYING' | 'BUILDING';
  repository?: string;
  gitAccountId?: string | null;
  branch?: string;
  /** null = the detected install */
  installCommand?: string | null;
  buildCommand?: string;
  /** before the build, after install — migrations */
  preDeployCommand?: string | null;
  startCommand?: string;
  port?: number;
  envVars?: Record<string, string>;
  userId: string | null;
  organizationId?: string | null;
  /** the Domain (zone) its hostname sits under */
  domainId?: string | null;
  /** list and detail endpoints: that domain, for its registration expiry */
  parentDomain?: { id: string; name: string; expiresAt?: string | null; shared?: boolean } | null;
  organization?: { id: string; name: string; slug: string } | null;
  createdAt: string;
  updatedAt: string;
  staticSiteUrl?: string | null;
  /** the site's Cloudflare R2 bucket, once files have been uploaded */
  staticBucket?: string | null;
  /** detail endpoint only: the node it runs on (found there, else its organization's) */
  placement?: { id: string; name: string; hostname: string; publicIp: string; tags: string[] } | null;
  runtime?: 'PM2' | 'CADDY_PHP' | 'CADDY_STATIC' | 'CADDY_PROXY' | null;
  processName?: string | null;
  rootPath?: string | null;
  configPath?: string | null;
  lastSyncedAt?: string | null;
  /** when the last successful deploy went out */
  lastDeployment?: string | null;
  deployments?: Deployment[];
  databases?: Database[];
  logs?: Log[];
}

export interface Deployment {
  id: string;
  applicationId: string;
  status: 'PENDING' | 'BUILDING' | 'DEPLOYING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  buildLogs?: string;
  /** deploy result: route errors, DNS warnings, upload summary */
  deployLogs?: string;
  deployedAt?: string;
  createdAt: string;
}

export interface Database {
  id: string;
  name: string;
  type: 'POSTGRESQL' | 'MYSQL' | 'MONGODB' | 'REDIS' | 'SQLITE';
  version?: string;
  config?: Record<string, unknown>;
  applicationId: string;
  createdAt: string;
}

export interface Log {
  id: string;
  applicationId: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
  message: string;
  timestamp: string;
}

export interface CreateApplicationData {
  name: string;
  domain: string;
  type: Application['type'];
  repository?: string;
  /** Connected GitHub/GitLab account that can clone a private repository. */
  gitAccountId?: string;
  branch?: string;
  buildCommand?: string;
  preDeployCommand?: string;
  startCommand?: string;
  port?: number;
  envVars?: Record<string, string>;
  /** Node to run on. Superadmin only; omitted = the organization's default server. */
  serverId?: string;
  /** Whose app it is under a shared platform domain; an owned domain decides it itself. */
  organizationId?: string;
  /** The user agreed to the DNS change the form showed (replace records / move to Cloudflare). */
  dnsConsent?: boolean;
}

export interface UpdateApplicationData {
  name?: string;
  domain?: string;
  type?: Application['type'];
  repository?: string;
  /** null clears it, undefined leaves it alone. */
  gitAccountId?: string | null;
  branch?: string;
  /** '' goes back to the detected install */
  installCommand?: string;
  buildCommand?: string;
  /** '' removes the step */
  preDeployCommand?: string;
  startCommand?: string;
  port?: number;
  envVars?: Record<string, string>;
  /** with a new domain: the user agreed to the DNS change shown */
  dnsConsent?: boolean;
}

// Get all applications
export const getApplications = async (params: ListParams): Promise<PaginatedResponse<Application>> => {
  const response = await apiRequest<PaginatedResponse<Application>>(`/applications${listQuery(params)}`);
  
  if (response.success && response.data) {
    return response.data;
  }
  
  throw new Error(response.error || t("Failed to fetch applications"));
};

// Get single application
export const getApplication = async (id: string): Promise<Application> => {
  const response = await apiRequest<Application>(`/applications/${id}`);
  
  if (response.success && response.data) {
    return response.data;
  }
  
  throw new Error(response.error || t("Failed to fetch application"));
};

// Create new application
export const createApplication = async (
  data: CreateApplicationData,
): Promise<Application & { dns?: DnsOutcome }> => {
  const response = await apiRequest<Application & { dns?: DnsOutcome }>('/applications', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  
  if (response.success && response.data) {
    return response.data;
  }
  
  throw new Error(response.error || t("Failed to create application"));
};

/** Live reachability of an app's hostname — DNS, certificate, HTTP answer. */
export interface HostnameHealth {
  host: string;
  resolves: boolean;
  https: boolean;
  httpStatus: number | null;
  live: boolean;
  error: string | null;
}

export const getApplicationHostname = async (id: string): Promise<HostnameHealth> => {
  const response = await apiRequest<HostnameHealth>(`/applications/${id}/hostname`);

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t("Failed to check the hostname"));
};

export interface DnsOutcome {
  state: 'created' | 'wildcard' | 'exists' | 'conflict' | 'unavailable';
  detail: string;
}

/** Point the hostname at the platform. `force` overwrites a record aimed elsewhere. */
export const setupApplicationDns = async (
  id: string,
  force = false,
): Promise<DnsOutcome> => {
  const response = await apiRequest<DnsOutcome>(`/applications/${id}/dns`, {
    method: 'POST',
    body: JSON.stringify({ force }),
  });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t("Failed to set up DNS"));
};

export interface DetectedProject {
  type: 'NODEJS' | 'STATIC' | 'PHP' | 'PYTHON';
  framework: string | null;
  label: string;
  packageManager: string;
  installCommand: string;
  buildCommand: string | null;
  startCommand: string | null;
  outputDir: string | null;
  port: number | null;
  nodeVersion: string | null;
  /** a step before the build — Prisma's migrations — or null */
  preDeployCommand?: string | null;
  /** a step before the build, run by the deploy on its own — Prisma's client generation — or null */
  generateCommand?: string | null;
  env: {
    /** keys from .env.example / .sample / .template, with defaults when they have one */
    example: { file: string; vars: Array<{ key: string; value: string }> } | null;
    /** keys the repo's .env.production sets — loaded at build by the framework itself */
    production: string[];
    /** .env / .env.local committed to the repository */
    committed: string[];
    needsDatabase: boolean;
  };
  /** what will misbehave behind the proxy — about the start script, so moot once a start command is set */
  warnings: Array<{ code: 'start-fixed-port'; port: string } | { code: 'start-binds-all' }>;
}

/** Detect an existing app's code as it is now — for its setup checklist. */
export const getAppDetection = async (id: string): Promise<DetectedProject> => {
  const response = await apiRequest<DetectedProject>(`/applications/${id}/detect`);
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t("Could not inspect the project"));
};

/** Files the backend reads to recognise a project. Must match DETECT_FILES there. */
export const DETECT_FILES = [
  '.env.example', '.env.sample', '.env.template', '.env.production', '.env', '.env.local',
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock',
  '.nvmrc', '.node-version', 'next.config.js', 'next.config.mjs', 'next.config.ts',
  'requirements.txt', 'composer.json', 'index.php', 'index.html',
];
/** Sent by presence only: lockfiles are huge, and a .env's secrets never leave the browser for detection. */
const PRESENCE_ONLY = /lock|^\.env(\.local)?$/;

/** Detect from a git URL, or from the files the browser already holds. */
export const detectProject = async (
  input: { repository: string; branch?: string; gitAccountId?: string } | { files: Record<string, string> }
): Promise<DetectedProject> => {
  const response = await apiRequest<DetectedProject>('/applications/detect', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t("Could not inspect the project"));
};

export type Release = {
  id: string;
  status: 'PENDING' | 'READY' | 'FAILED' | string;
  commitSha?: string | null;
  /** static sites: the release's folder in R2 — '' for files from before releases */
  path?: string | null;
  /** the deploy that produced it — null for releases from before that was recorded */
  deploymentId?: string | null;
  createdAt: string;
};

/** Built releases, newest first, and which one is serving. */
export const getReleases = async (
  id: string
): Promise<{ activeReleaseId: string | null; releases: Release[] }> => {
  const response = await apiRequest<{ activeReleaseId: string | null; releases: Release[] }>(
    `/applications/${id}/releases`
  );
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t("Failed to load releases"));
};

/** Roll back (or forward) to an already-built release — no rebuild. */
export const activateRelease = async (id: string, releaseId: string): Promise<void> => {
  const response = await apiRequest(`/applications/${id}/releases/${releaseId}/activate`, { method: 'POST' });
  if (!response.success) throw new Error(response.error || t("Could not switch to that release"));
};

/** The build log of the deploy in progress, as far as it has got. */
export const getLiveBuildLog = async (id: string): Promise<string> => {
  const response = await apiRequest<{ logs: string }>(`/logs/application/${id}/build-live`);
  if (response.success && response.data) return response.data.logs;
  throw new Error(response.error || t("Could not read the build log"));
};

export type SiteFile = { key: string; size: number; lastModified: string | null };

/** What a static site's bucket holds, and its public host for opening a file. */
export const getSiteFiles = async (id: string): Promise<{ origin: string | null; files: SiteFile[] }> => {
  const response = await apiRequest<{ origin: string | null; files: SiteFile[] }>(`/applications/${id}/files`);
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t("Could not list the files"));
};

export const deleteSiteFiles = async (id: string, keys: string[]): Promise<number> => {
  const response = await apiRequest<{ deleted: number }>(`/applications/${id}/files`, {
    method: 'DELETE',
    body: JSON.stringify({ keys }),
  });
  if (response.success && response.data) return response.data.deleted;
  throw new Error(response.error || t("Could not delete the files"));
};

export type RepositoryBranches = {
  defaultBranch: string | null;
  branches: string[];
  /** the caller's account that could read a private repo; null when it is public */
  gitAccountId: string | null;
  /** private (or missing) and none of the caller's accounts on this host can read it */
  needsAccount?: 'github' | 'gitlab';
  triedAccounts?: number;
};

/** Branches of a pasted repository URL — public, or private through one of your connected accounts. */
export const listRepositoryBranches = async (repository: string): Promise<RepositoryBranches> => {
  const response = await apiRequest<RepositoryBranches>(
    '/applications/branches',
    { method: 'POST', body: JSON.stringify({ repository }) }
  );
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t("Could not read the branches"));
};

/** An app's repository right now: branches, each one's newest commit, and the commit that is live. */
export type AppBranches = {
  defaultBranch: string | null;
  branches: string[];
  heads: Record<string, string>;
  branch: string;
  liveCommit: string | null;
};

export const getAppBranches = async (id: string): Promise<AppBranches> => {
  const response = await apiRequest<AppBranches>(`/applications/${id}/branches`);
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t("Could not read the branches"));
};

/**
 * A file to upload and its path inside the upload. Kept apart from the File
 * because dropped files carry no webkitRelativePath.
 */
export type UploadEntry = { file: File; path: string };

const SKIPPED = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db']);

/**
 * Tidy a raw selection: skip .git and node_modules (never deployed, and
 * node_modules alone can blow the upload limit) and OS junk, and drop the
 * single folder everything sits in — a picked or dropped "mysite/" deploys its
 * contents at the root, index.html rather than mysite/index.html.
 */
export const toUploadEntries = (raw: UploadEntry[]): UploadEntry[] => {
  const items = raw.filter(({ path }) => !path.split('/').some((part) => SKIPPED.has(part)));
  const top = items[0]?.path.split('/')[0];
  const wrapped = items.length > 0 && items.every(({ path }) => path.includes('/') && path.split('/')[0] === top);
  return wrapped ? items.map((item) => ({ ...item, path: item.path.slice(top.length + 1) })) : items;
};

/** From an <input type="file">, folder picker or not. */
export const entriesFromInput = (files: FileList | null): UploadEntry[] =>
  toUploadEntries(Array.from(files ?? []).map((file) => ({ file, path: file.webkitRelativePath || file.name })));

/**
 * From a drop, walking into any folders. The entries must be taken before the
 * first await — the browser empties the DataTransfer once the event returns.
 */
export const entriesFromDrop = async (items: DataTransferItemList): Promise<UploadEntry[]> => {
  const roots = Array.from(items)
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);
  const out: UploadEntry[] = [];

  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ file, path: entry.fullPath.replace(/^\//, '') });
    } else if (entry.isDirectory && entry.name !== '.git' && entry.name !== 'node_modules') {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries hands back one batch at a time; empty means done
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child);
      }
    }
  };

  for (const root of roots) await walk(root);
  return toUploadEntries(out);
};

/**
 * The usual ways a static upload goes wrong: no index.html at the root (the
 * site 404s), or a project picked instead of its build output. `buildDir` is
 * the output folder when one sits inside the pick, so it can be picked instead.
 */
export const checkStaticUpload = (entries: UploadEntry[]) => {
  const paths = new Set(entries.map(({ path }) => path));
  return {
    hasIndex: paths.has('index.html'),
    // not public/: that is CRA's template, not a build
    buildDir: ['dist', 'build', 'out', '_site'].find((dir) => paths.has(`${dir}/index.html`)),
    looksLikeSource: paths.has('package.json') || [...paths].some((path) => path.startsWith('src/')),
  };
};

/** Pull the detection files out of an upload (root level only). */
export const readDetectFiles = async (entries: UploadEntry[]): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const { file, path } of entries) {
    if (path.includes('/') || !DETECT_FILES.includes(path)) continue;
    out[path] = PRESENCE_ONLY.test(path) ? '' : await file.slice(0, 256 * 1024).text();
  }
  return out;
};

/**
 * Ship a picked file or folder as the app's sources. FormData, so it cannot go
 * through apiRequest — that one forces a JSON content type. XHR rather than
 * fetch: fetch reports no upload progress.
 */
export const uploadApplicationSource = async (
  id: string,
  entries: UploadEntry[],
  options: {
    /** static sites: the upload becomes the whole site, files it lacks are removed */
    replace?: boolean;
    /** 0..1 of the bytes sent; at 1 the server is still publishing them */
    onProgress?: (fraction: number) => void;
  } = {}
): Promise<{ files: number }> => {
  const body = new FormData();
  if (options.replace) body.append('replace', 'true');
  entries.forEach(({ file, path }) => {
    body.append('files', file);
    body.append('paths', path);
  });

  const token = localStorage.getItem('authToken');
  const data = await new Promise<{ success?: boolean; error?: string; data?: { files: number } }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE_URL}/applications/${id}/source`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && options.onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      try {
        const parsed = JSON.parse(xhr.responseText);
        resolve(xhr.status >= 200 && xhr.status < 300 ? parsed : { ...parsed, success: false });
      } catch {
        reject(new Error(t("Failed to upload source files")));
      }
    };
    xhr.onerror = () => reject(new Error(t("Failed to upload source files")));
    xhr.send(body);
  });

  if (!data.success) {
    throw new Error(data.error || t("Failed to upload source files"));
  }

  return data.data!;
};

// Update application
export const updateApplication = async (id: string, data: UpdateApplicationData): Promise<Application> => {
  const response = await apiRequest<Application>(`/applications/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  
  if (response.success && response.data) {
    return response.data;
  }
  
  throw new Error(response.error || t("Failed to update application"));
};

/** What a hostname is today, before an app takes it (GET /applications/hostname-check). */
export interface HostInspection {
  usedBy: { id: string | null; name: string | null } | null;
  apex: boolean;
  /** who answers DNS for the domain: a Cloudflare zone we edit, RDASH (movable to Cloudflare), or someone else */
  dns: "cloudflare" | "registrar" | "external" | "unknown";
  /** records at the name pointing elsewhere — replaced only with consent */
  replaces: { type: string; content: string }[];
  pointsHere: boolean;
  /** the record the app gets */
  target: { type: "A" | "CNAME"; content: string } | null;
  /** may this user move the domain to Cloudflare */
  canMove: boolean;
}

/** DNS the app would change: records to replace, or a registrar domain to move. */
export const dnsNeedsConsent = (inspection?: HostInspection | null) =>
  !!inspection &&
  !inspection.usedBy &&
  ((inspection.dns === "cloudflare" && inspection.replaces.length > 0) ||
    (inspection.dns === "registrar" && inspection.canMove));

export const checkHostname = async (
  host: string,
  opts: { excludeAppId?: string; serverId?: string; organizationId?: string } = {},
): Promise<HostInspection> => {
  const query = new URLSearchParams({
    host,
    ...(opts.excludeAppId && { exclude: opts.excludeAppId }),
    ...(opts.serverId && { serverId: opts.serverId }),
    ...(opts.organizationId && { organizationId: opts.organizationId }),
  });
  const response = await apiRequest<HostInspection>(`/applications/hostname-check?${query}`);
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t("Could not check the hostname"));
};

// Delete application
export const deleteApplication = async (id: string): Promise<void> => {
  const response = await apiRequest(`/applications/${id}`, {
    method: 'DELETE',
  });
  
  if (!response.success) {
    throw new Error(response.error || t("Failed to delete application"));
  }
};

// Start existing application (without redeploying)
export const startExistingApplication = async (id: string): Promise<Application | boolean> => {
  const response = await apiRequest<Application>(`/applications/${id}/start-existing`, {
    method: 'POST',
  });
  
  if (response.success) {
    return response.data || true;
  }
  
  throw new Error(response.error || t("Failed to start existing application"));
};

// Start application (with redeploy)
export const startApplication = async (id: string): Promise<Application | boolean> => {
  const response = await apiRequest<Application>(`/applications/${id}/start`, {
    method: 'POST',
  });
  
  if (response.success) {
    return response.data || true;
  }
  
  throw new Error(response.error || t("Failed to start application"));
};

export type ReleaseState = 'live' | 'rollback' | 'unused';

/** What an app's tree on its node costs. Shared files are counted once, on the live release. */
export interface AppDisk {
  releases: Array<{ name: string; bytes: number; state: ReleaseState }>;
  cacheBytes: number;
  logsBytes: number;
  sourcesBytes: number;
  totalBytes: number;
  reclaimableBytes: number;
}

/** Null for a static site — its files are in R2, not on a node. */
export const getAppDisk = async (id: string): Promise<AppDisk | null> => {
  const response = await apiRequest<AppDisk | null>(`/applications/${id}/disk`);
  if (response.success) return response.data ?? null;
  throw new Error(response.error || t("Could not read the disk usage"));
};

/** Remove unused releases (and with `cache` the build cache); what was freed, measured. */
export const cleanupAppDisk = async (id: string, cache: boolean): Promise<{ removed: string[]; freedBytes: number }> => {
  const response = await apiRequest<{ removed: string[]; freedBytes: number }>(`/applications/${id}/cleanup`, {
    method: 'POST',
    body: JSON.stringify({ cache }),
  });
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t("Could not clean up"));
};

/** Stop the running deploy; it ends as CANCELLED and what served before keeps serving. */
export const cancelDeployment = async (id: string): Promise<void> => {
  const response = await apiRequest(`/applications/${id}/deploy/cancel`, { method: 'POST' });
  if (!response.success) throw new Error(response.error || t("Could not cancel the deployment"));
};

// Stop application
export const stopApplication = async (id: string): Promise<Application | boolean> => {
  const response = await apiRequest<Application>(`/applications/${id}/stop`, {
    method: 'POST',
  });
  
  if (response.success) {
    return response.data || true;
  }
  
  throw new Error(response.error || t("Failed to stop application"));
};

// Restart application
export const restartApplication = async (id: string): Promise<Application | boolean> => {
  const response = await apiRequest<Application>(`/applications/${id}/restart`, {
    method: 'POST',
  });
  
  if (response.success) {
    return response.data || true;
  }
  
  throw new Error(response.error || t("Failed to restart application"));
};

// Check if application has been deployed before
export const hasBeenDeployed = (application: Application): boolean => {
  // Check if there are any successful deployments
  if (application.deployments && application.deployments.length > 0) {
    return application.deployments.some(deployment => 
      deployment.status === 'SUCCESS'
    );
  }
  
  // Check if lastDeployment exists (from backend)
  return !!application.lastDeployment;
}; 

export interface AppSyncResult {
  discovered: number;
  created: number;
  updated: number;
  apps: Array<{
    name: string;
    domain: string;
    runtime: 'PM2' | 'CADDY_PHP' | 'CADDY_STATIC' | 'CADDY_PROXY';
    status: 'RUNNING' | 'STOPPED' | 'ERROR';
    port?: number;
    action: 'created' | 'updated';
  }>;
  errors?: string[];
}

// Import/refresh the apps running on the server (pm2 processes + Caddy sites)
export const syncServerApps = async (): Promise<AppSyncResult> => {
  const response = await apiRequest<AppSyncResult>('/applications/sync', { method: 'POST' });

  if (response.success && response.data) {
    return response.data;
  }

  throw new Error(response.error || t("Failed to sync server apps"));
};

/** Give many applications an owner at once — the imported-sites workflow. */
export const bulkAssignApplications = async (
  ids: string[],
  organizationId: string | null,
): Promise<number> => {
  const response = await apiRequest<{ count: number }>('/applications/bulk-assign', {
    method: 'PATCH',
    body: JSON.stringify({ ids, organizationId }),
  });

  if (response.success && response.data) return response.data.count;
  throw new Error(response.error || t("Failed to assign applications"));
};
