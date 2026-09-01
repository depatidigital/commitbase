import { exec } from 'child_process';
import { promisify } from 'util';
import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { prisma } from '../lib/prisma';

const execAsync = promisify(exec);

const CADDY_SITES_DIR = process.env.CADDY_SITES_DIR || '/etc/caddy/sites';
const APPS_ROOT_DIR = process.env.APPS_ROOT_DIR || '/var/www/html';

export type Runtime = 'PM2' | 'CADDY_PHP' | 'CADDY_STATIC' | 'CADDY_PROXY';

export type DiscoveredApp = {
  name: string;
  domain: string;
  runtime: Runtime;
  type: 'NODEJS' | 'PHP' | 'STATIC';
  status: 'RUNNING' | 'STOPPED' | 'ERROR';
  port?: number | undefined;
  processName?: string | undefined;
  rootPath?: string | undefined;
  configPath?: string | undefined;
  memory?: string | undefined;
  cpu?: string | undefined;
  uptime?: string | undefined;
};

export type AppSyncResult = {
  discovered: number;
  created: number;
  updated: number;
  apps: Array<DiscoveredApp & { action: 'created' | 'updated' }>;
  errors?: string[];
};

type Pm2Process = {
  name: string;
  status: string;
  port?: number | undefined;
  cwd?: string | undefined;
  memory?: string | undefined;
  cpu?: string | undefined;
  uptime?: string | undefined;
};

function humanBytes(bytes: number): string {
  if (!bytes) return '0MB';
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

function humanUptime(startedAt: number): string {
  if (!startedAt) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** `pm2 jlist` — an empty list when pm2 is missing, so a dev box just sees the Caddy side. */
export async function listPm2Processes(): Promise<Pm2Process[]> {
  try {
    const { stdout } = await execAsync('pm2 jlist', { maxBuffer: 10 * 1024 * 1024 });
    const raw = JSON.parse(stdout || '[]');

    return (Array.isArray(raw) ? raw : [])
      .map((process: any) => {
        const env = process.pm2_env || {};
        const portRaw = env.PORT ?? env.env?.PORT;
        const port = Number(portRaw);

        return {
          name: String(process.name || ''),
          status: String(env.status || 'unknown'),
          port: Number.isFinite(port) && port > 0 ? port : undefined,
          cwd: env.pm_cwd || env.cwd,
          memory: humanBytes(process.monit?.memory || 0),
          cpu: process.monit?.cpu != null ? `${process.monit.cpu}%` : undefined,
          uptime: env.pm_uptime ? humanUptime(env.pm_uptime) : undefined,
        };
      })
      .filter((process) => process.name);
  } catch {
    return [];
  }
}

export type CaddySite = {
  domains: string[];
  port?: number | undefined;
  rootPath?: string | undefined;
  php: boolean;
  configPath: string;
};

/**
 * Flat-parse a Caddyfile: every top-level `host… {` opens a site block, and we
 * only care about three directives inside it.
 * ponytail: a text scan, not a real Caddyfile parser — enough for the
 * one-site-per-file layout in /etc/caddy/sites. Swap in `caddy adapt` output if
 * the configs ever grow snippets or imports.
 */
export function parseCaddyfile(content: string, configPath: string): CaddySite[] {
  const sites: CaddySite[] = [];
  let current: CaddySite | null = null;
  let depth = 0;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (depth === 0) {
      if (!line.endsWith('{')) continue;

      const domains = line
        .slice(0, -1)
        .trim()
        .split(/[,\s]+/)
        .map((token) => token.replace(/^https?:\/\//, '').split('/')[0] || '')
        .filter((token) => /^[a-z0-9*.-]+\.[a-z]{2,}$/i.test(token));

      current = { domains, php: false, configPath };
      depth = 1;
      continue;
    }

    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;

    if (depth <= 0) {
      if (current && current.domains.length) sites.push(current);
      current = null;
      depth = 0;
      continue;
    }

    if (!current) continue;

    const proxy = line.match(/^reverse_proxy\s+.*?:(\d+)/);
    if (proxy?.[1]) current.port = Number(proxy[1]);

    const root = line.match(/^root\s+(?:\*\s+)?(\S+)/);
    if (root?.[1]) current.rootPath = root[1];

    if (line.startsWith('php_fastcgi')) current.php = true;
  }

  return sites;
}

export async function listCaddySites(): Promise<CaddySite[]> {
  let files: string[] = [];
  try {
    files = (await readdir(CADDY_SITES_DIR)).filter((file) => file.endsWith('.caddy'));
  } catch {
    return [];
  }

  const sites: CaddySite[] = [];
  for (const file of files) {
    const configPath = path.join(CADDY_SITES_DIR, file);
    try {
      sites.push(...parseCaddyfile(await readFile(configPath, 'utf8'), configPath));
    } catch {
      // unreadable file — skip it, the rest of the inventory still syncs
    }
  }

  return sites;
}

/**
 * What is actually running on the box: Caddy sites (PHP, static, proxy) joined
 * with the pm2 process behind each proxied port. pm2 processes with no Caddy
 * site are reported too, under a `<name>.pm2.local` placeholder host.
 */
export async function scanServerApps(): Promise<DiscoveredApp[]> {
  const [processes, sites] = await Promise.all([listPm2Processes(), listCaddySites()]);
  const byPort = new Map<number, Pm2Process>();
  for (const process of processes) {
    if (process.port) byPort.set(process.port, process);
  }

  const apps: DiscoveredApp[] = [];
  const claimed = new Set<string>();

  for (const site of sites) {
    const domain = site.domains[0];
    if (!domain) continue;
    const process = site.port ? byPort.get(site.port) : undefined;
    if (process) claimed.add(process.name);

    const runtime: Runtime = site.port
      ? process
        ? 'PM2'
        : 'CADDY_PROXY'
      : site.php
        ? 'CADDY_PHP'
        : 'CADDY_STATIC';

    apps.push({
      name: process?.name || path.basename(site.configPath, '.caddy'),
      domain,
      runtime,
      type: runtime === 'CADDY_PHP' ? 'PHP' : runtime === 'CADDY_STATIC' ? 'STATIC' : 'NODEJS',
      status: process
        ? process.status === 'online'
          ? 'RUNNING'
          : 'STOPPED'
        : site.port
          ? 'ERROR' // routed to a port nothing is listening on
          : 'RUNNING',
      port: site.port,
      processName: process?.name,
      rootPath: site.rootPath || (site.port ? undefined : path.join(APPS_ROOT_DIR, domain)),
      configPath: site.configPath,
      memory: process?.memory,
      cpu: process?.cpu,
      uptime: process?.uptime,
    });
  }

  for (const process of processes) {
    if (claimed.has(process.name)) continue;

    apps.push({
      name: process.name,
      domain: `${process.name}.pm2.local`,
      runtime: 'PM2',
      type: 'NODEJS',
      status: process.status === 'online' ? 'RUNNING' : 'STOPPED',
      port: process.port,
      processName: process.name,
      rootPath: process.cwd,
      memory: process.memory,
      cpu: process.cpu,
      uptime: process.uptime,
    });
  }

  return apps;
}

/**
 * Reconcile the scan into the applications table, keyed on the domain. Synced
 * apps land unassigned (no organization) — a superadmin assigns them
 * afterwards, the same way domain sync works.
 */
export async function syncServerApps(userId: string): Promise<AppSyncResult> {
  const discovered = await scanServerApps();
  const result: AppSyncResult = { discovered: discovered.length, created: 0, updated: 0, apps: [] };
  const errors: string[] = [];

  for (const app of discovered) {
    const fields = {
      runtime: app.runtime,
      processName: app.processName ?? null,
      rootPath: app.rootPath ?? null,
      configPath: app.configPath ?? null,
      status: app.status,
      port: app.port ?? null,
      memory: app.memory ?? null,
      cpu: app.cpu ?? null,
      uptime: app.uptime ?? null,
      lastSyncedAt: new Date(),
    };

    try {
      const existing = await prisma.application.findUnique({ where: { domain: app.domain } });

      if (existing) {
        await prisma.application.update({ where: { id: existing.id }, data: fields });
        result.updated += 1;
        result.apps.push({ ...app, action: 'updated' });
      } else {
        await prisma.application.create({
          data: { name: app.name, domain: app.domain, type: app.type, userId, ...fields },
        });
        result.created += 1;
        result.apps.push({ ...app, action: 'created' });
      }
    } catch (error: any) {
      errors.push(`${app.domain}: ${error?.message || 'sync failed'}`);
    }
  }

  if (errors.length) result.errors = errors;
  return result;
}

/**
 * Control a pm2-managed app discovered by the sync. Docker-deployed apps keep
 * going through DeploymentService — this only covers processes pm2 owns.
 */
export async function controlPm2Process(
  processName: string,
  action: 'start' | 'stop' | 'restart'
): Promise<{ success: boolean; output: string }> {
  try {
    const { stdout } = await execAsync(`pm2 ${action} ${JSON.stringify(processName)}`, {
      maxBuffer: 5 * 1024 * 1024,
    });
    return { success: true, output: stdout || '' };
  } catch (error: any) {
    return { success: false, output: error?.stderr || error?.message || `pm2 ${action} failed` };
  }
}
