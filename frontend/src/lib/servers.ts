import apiRequest from './api';
import { ListParams, listQuery } from './admin';
import type { Paginated } from '@/components/DataTable';
import type { Organization, ProvisionState } from './organizations';
import { t } from '@/lib/i18n';

export type ServerStatus = 'ONLINE' | 'OFFLINE' | 'UNKNOWN';

/** How the control plane authenticates to a node. Keys are the default. */
export type AuthMethod = 'KEY' | 'PASSWORD';

/** From here on a disk shows red — the Storage tab and the server list agree. */
export const DISK_RED_PCT = 90;

export const diskUsedPct = (disk: { size: number; used: number } | null | undefined): number =>
  disk?.size ? Math.round((disk.used / disk.size) * 100) : 0;

export interface Server {
  id: string;
  name: string;
  hostname: string;
  sshUser: string;
  sshPort: number;
  authMethod: AuthMethod;
  sshKeyPath: string | null;
  /** The password itself never leaves the backend — only whether one is stored. */
  hasPassword: boolean;
  publicIp: string;
  tags: string[];
  /** "NONE" | "PODMAN" — whether compose apps may be placed here. */
  containerRuntime: ContainerRuntime;
  /** What the heartbeat found on the box; null until the first successful check. */
  runtimes: { name: string; active: boolean; state?: string; version?: string }[] | null;
  /** The tenants' partition, from the last heartbeat, in bytes. */
  disk: { size: number; used: number; avail: number } | null;
  status: ServerStatus;
  /** Can the panel become root here? A node can be reachable and still not set up. */
  provisioned: boolean;
  lastSeenAt: string | null;
  lastError: string | null;
  /** Setup queue: install.sh run over SSH by the panel. */
  setupState: ProvisionState;
  setupError: string | null;
  /** Tail of the last setup run's output. */
  setupLog: string | null;
  setupAt: string | null;
  createdAt: string;
  /** organizations provisioned on this node */
  _count: { orgNodes: number };
}

export interface ServerDetail extends Server {
  organizations: Array<{ id: string; name: string; slug: string; state: ProvisionState }>;
}

export type ContainerRuntime = 'NONE' | 'PODMAN';

export type ServerInput = {
  name: string;
  hostname: string;
  sshUser: string;
  sshPort: number;
  authMethod: AuthMethod;
  sshKeyPath?: string;
  /** Sent only when set; an empty value on edit keeps the stored one. */
  sshPassword?: string;
  publicIp: string;
  tags: string[];
  containerRuntime: ContainerRuntime;
};

const unwrap = <T>(res: { success: boolean; data?: T; error?: string }, fallback: string): T => {
  if (res.success) return res.data as T;
  throw new Error(res.error || fallback);
};

export const getServers = async (): Promise<Server[]> =>
  unwrap(await apiRequest<Server[]>('/servers'), t('Failed to fetch servers'));

export const getServersPage = async (
  params: ListParams,
  tag = '',
): Promise<Paginated<Server>> =>
  unwrap(
    await apiRequest<Paginated<Server>>(
      `/servers${listQuery(params)}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}`,
    ),
    t('Failed to fetch servers'),
  );

export type LogSource = 'errors' | 'system' | 'caddy' | 'ssh' | 'php' | 'apps';

export const getServerLogs = async (
  id: string,
  source: LogSource,
  lines = 200,
): Promise<{ source: LogSource; lines: number; output: string }> =>
  unwrap(
    await apiRequest(`/servers/${id}/logs?source=${source}&lines=${lines}`),
    t('Failed to read server logs'),
  );

export const getServer = async (id: string): Promise<ServerDetail> =>
  unwrap(await apiRequest<ServerDetail>(`/servers/${id}`), t('Failed to fetch server'));

export const createServer = async (data: ServerInput): Promise<Server> =>
  unwrap(await apiRequest<Server>('/servers', { method: 'POST', body: JSON.stringify(data) }), t('Failed to register server'));

export const updateServer = async (id: string, data: Partial<ServerInput>): Promise<Server> =>
  unwrap(await apiRequest<Server>(`/servers/${id}`, { method: 'PUT', body: JSON.stringify(data) }), t('Failed to update server'));

export const deleteServer = async (id: string) =>
  unwrap(await apiRequest(`/servers/${id}`, { method: 'DELETE' }), t('Failed to delete server'));

export const pingServer = async (
  id: string
): Promise<{ id: string; name: string; status: ServerStatus; provisioned: boolean; error?: string }> =>
  unwrap(await apiRequest(`/servers/${id}/ping`, { method: 'POST' }), t('Failed to reach server'));

/** Queue install.sh on this node, run over SSH. */
export const setupServer = async (id: string) =>
  unwrap(
    await apiRequest(`/servers/${id}/setup`, { method: 'POST' }),
    t('Failed to queue server setup'),
  );

/** Set an organization's default server (where its new apps go). `null` clears it. Also provisions the org there. */
export const setOrganizationServer = async (orgId: string, serverId: string | null): Promise<Organization> =>
  unwrap(
    await apiRequest<Organization>(`/organizations/${orgId}/server`, {
      method: 'PUT',
      body: JSON.stringify({ serverId }),
    }),
    t('Failed to set the default server')
  );

/** One hostname this node's Caddy is serving, as the route describes it. */
export interface CaddySite {
  host: string;
  kind: 'NODEJS' | 'PHP' | 'STATIC' | 'OTHER';
  port: number | null;
  rootPath: string | null;
  socket: string | null;
  origin: string | null;
  /** false for the wildcard and the panel itself — routes, but not apps */
  managed: boolean;
}

export const getServerCaddySites = async (id: string): Promise<CaddySite[]> =>
  unwrap(await apiRequest<CaddySite[]>(`/servers/${id}/caddy/routes`), t('Failed to read Caddy routes'));

export interface ServerApp {
  id: string;
  name: string;
  domains: Array<{ host: string }>;
  type: string;
  status: string;
  port: number | null;
  runtime: string | null;
  lastDeployment: string | null;
  organization: { id: string; name: string; slug: string } | null;
}

export const getServerApps = async (id: string): Promise<ServerApp[]> =>
  unwrap(await apiRequest<ServerApp[]>(`/servers/${id}/apps`), t('Failed to fetch applications'));

export interface CaddySnapshotMeta {
  id: string;
  hosts: string[];
  /** what produced it: "before route a.com → bucket", "health check"… */
  reason: string | null;
  /** a baseline the watchdog restores on its own; the rest is change history */
  checkpoint: boolean;
  createdAt: string;
}

/** Roll the node's Caddy back to one snapshot. Resolves to the server's summary. */
export const restoreServerSnapshot = async (id: string, snapshotId: string): Promise<string> => {
  const res = await apiRequest(`/servers/${id}/caddy/snapshots/${snapshotId}/restore`, { method: 'POST' });
  if (res.success) return res.message || t('Snapshot restored');
  throw new Error(res.error || t('Failed to restore the snapshot'));
};

export const getServerSnapshots = async (id: string): Promise<CaddySnapshotMeta[]> =>
  unwrap(await apiRequest<CaddySnapshotMeta[]>(`/servers/${id}/caddy/snapshots`), t('Failed to fetch snapshots'));

export const snapshotServerCaddy = async (id: string): Promise<string> => {
  const res = await apiRequest(`/servers/${id}/caddy/snapshot`, { method: 'POST' });
  if (res.success) return res.message || t('Snapshot taken');
  throw new Error(res.error || t('Failed to snapshot the Caddy config'));
};

/** The node's disk, and each panel app on it: what it uses and what cleaning up frees. */
export interface ServerDisk {
  disk: { size: number; used: number; avail: number } | null;
  apps: Array<{ id: string; name: string; domains: Array<{ host: string }>; totalBytes: number | null; reclaimableBytes: number; cacheBytes: number }>;
}

export const getServerDisk = async (id: string): Promise<ServerDisk> =>
  unwrap(await apiRequest<ServerDisk>(`/servers/${id}/disk`), t('Could not read the disk usage'));

/** Clean up every panel app on the node; apps mid-deploy are skipped. */
export const cleanupServerDisk = async (
  id: string,
  cache: boolean,
): Promise<{ freedBytes: number; skipped: string[] }> =>
  unwrap(
    await apiRequest(`/servers/${id}/cleanup`, { method: 'POST', body: JSON.stringify({ cache }) }),
    t('Could not clean up'),
  );

/** The node's own clutter, by target id; a target missing from the node is absent. */
export const SYSTEM_TARGETS = ['journal', 'rotatedLogs', 'pm2Logs', 'aptCache', 'packageCaches', 'docker', 'crashDumps', 'oldTmp'] as const;
export type SystemTarget = (typeof SYSTEM_TARGETS)[number];

export interface SystemCleanup {
  targets: Partial<Record<SystemTarget, number>>;
  disk: ServerDisk['disk'];
}

export const getSystemCleanup = async (id: string): Promise<SystemCleanup> =>
  unwrap(await apiRequest<SystemCleanup>(`/servers/${id}/system-cleanup`), t('Could not read the disk usage'));

export const runSystemCleanup = async (id: string, targets: SystemTarget[]): Promise<{ freedBytes: number; failed: string[] }> =>
  unwrap(
    await apiRequest(`/servers/${id}/system-cleanup`, { method: 'POST', body: JSON.stringify({ targets }) }),
    t('Could not clean up'),
  );

/** Turn this node's live Caddy routes into application rows. */
export const syncServerApps = async (
  id: string,
): Promise<{ discovered: number; created: number; updated: number; errors?: string[] }> =>
  unwrap(
    await apiRequest(`/servers/${id}/sync-apps`, { method: 'POST' }),
    t('Failed to import sites from this server'),
  );

/** One nginx site on a node, and what migrating it to Caddy would do. */
export interface NginxSitePlan {
  site: {
    hosts: string[];
    kind: 'proxy' | 'php' | 'static' | 'redirect' | 'unknown';
    port?: number;
    root?: string;
    socket?: string;
    spa?: boolean;
    maxBodyBytes?: number;
    readTimeout?: string;
    streaming?: boolean;
    /** paths nginx denies, carried over as 403s */
    deny?: string[];
    warnings: string[];
  };
  serve: Record<string, unknown> | null;
  /** hostnames whose DNS does not point here — their certificates would fail */
  danglingHosts: string[];
  /** behind Cloudflare's proxy: the origin is not visible in DNS, so not called dangling */
  proxiedHosts?: string[];
  blocked: string | null;
  /** the Caddy route it becomes, exactly as it will be loaded */
  route?: unknown;
}

export interface NginxPlan {
  files: string[];
  sites: NginxSitePlan[];
  ready: boolean;
  /** caddy-api is on the node; Set up installs it (stopped) beside a running nginx */
  caddyInstalled: boolean;
  /** the latest migrate attempt on this node, from the panel's log */
  lastAttempt: { at: string; switched: boolean; message: string } | null;
}

export interface NginxMigration {
  switched: boolean;
  verified: string[];
  failed: string[];
  rolledBack: boolean;
  message: string;
}

/** Read this node's nginx configuration. Changes nothing. */
export const getNginxPlan = async (id: string): Promise<NginxPlan> =>
  unwrap(await apiRequest<NginxPlan>(`/servers/${id}/nginx`), t('Could not read the nginx configuration'));

/** Switch this node's sites from nginx to Caddy, rolling back if any host stops answering. */
export const migrateNginx = async (id: string): Promise<NginxMigration> =>
  unwrap(await apiRequest<NginxMigration>(`/servers/${id}/nginx/migrate`, { method: 'POST' }), t('Could not migrate this node'));

/** One published port of a running container, and who sends traffic to it. */
export interface DockerPortMap {
  port: number;
  nginxHosts: string[];
  caddyHosts: string[];
  /** the panel app already on this port of this node */
  app: { id: string; name: string; runtime: string | null } | null;
}

export interface DockerContainerView {
  name: string;
  image: string;
  status: string;
  ports: number[];
  maps: DockerPortMap[];
}

export const getDockerContainers = async (id: string): Promise<DockerContainerView[]> =>
  unwrap(await apiRequest<DockerContainerView[]>(`/servers/${id}/docker`), t('Could not read the docker containers'));

/** Adopt one container's port as an app. The container itself is not touched. */
export const importDockerContainer = async (
  id: string,
  container: string,
  port: number,
): Promise<{ id: string; created: boolean; hosts: string[]; skippedHosts: string[] }> =>
  unwrap(
    await apiRequest(`/servers/${id}/docker/import`, { method: 'POST', body: JSON.stringify({ container, port }) }),
    t('Could not import the container'),
  );

/** First certificate for a hostname behind Cloudflare: proxy off, Caddy restarted, proxy back on. Takes minutes. */
export const provisionSsl = async (id: string, host: string): Promise<{ ok: boolean; message: string; steps: string[] }> =>
  unwrap(
    await apiRequest(`/servers/${id}/ssl`, { method: 'POST', body: JSON.stringify({ host }) }),
    t('Could not provision SSL'),
  );
