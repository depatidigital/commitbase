import { exec as localExec } from 'child_process';
import { promisify } from 'util';
import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { prisma } from '../lib/prisma';
import { exec, type SshTarget } from '../lib/runner';
import { allServers } from '../lib/servers';
import { getCaddyConfig } from './caddyService';

const execAsync = promisify(localExec);

/** The panel's own hostname is a route like any other, and is not a tenant app. */
const PANEL_HOST = (process.env.PANEL_HOST || process.env.FRONTEND_HOST || '').trim().toLowerCase();

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

/** `pm2 jlist` on a node — an empty list when pm2 is missing, so a box without it just shows its Caddy side. */
export async function listPm2Processes(node: SshTarget): Promise<Pm2Process[]> {
  try {
    const { stdout } = await exec(node, ['pm2', 'jlist'], { maxBuffer: 10 * 1024 * 1024 });
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
  /** PHP sites: the FPM socket from `php_fastcgi unix/...` */
  socket?: string | undefined;
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

    if (line.startsWith('php_fastcgi')) {
      current.php = true;
      // the FPM socket the site talks to — needed to rebuild this site as an
      // API route, which is the only place it is written down
      const socket = line.match(/unix\/+(\S+)/);
      if (socket?.[1]) current.socket = `/${socket[1].replace(/^\/+/, '')}`;
    }
  }

  return sites;
}

/**
 * What one live Caddy route is, as an application.
 *
 * The site files this used to read are gone: routes live in Caddy's memory and
 * the admin API is the only place they exist, so the JSON handler shape is what
 * says whether a hostname is a PHP site, a static one or a proxied process.
 * Pure — the self-check drives it with config JSON and no I/O.
 */
export function classifyRoute(route: any): {
  type: 'NODEJS' | 'PHP' | 'STATIC';
  port?: number | undefined;
  rootPath?: string | undefined;
  socket?: string | undefined;
  origin?: string | undefined;
} | null {
  // handlers can be nested one subroute deep, which is how the PHP and bucket
  // routes this platform writes are shaped
  const handlers: any[] = [];
  const walk = (list: any[]) => {
    for (const handler of Array.isArray(list) ? list : []) {
      handlers.push(handler);
      if (handler?.handler === 'subroute') {
        for (const nested of Array.isArray(handler.routes) ? handler.routes : []) walk(nested?.handle);
      }
    }
  };
  walk(route?.handle);

  const proxy = handlers.find((handler) => handler?.handler === 'reverse_proxy');
  const dial = String(proxy?.upstreams?.[0]?.dial ?? '');

  if (proxy?.transport?.protocol === 'fastcgi') {
    return {
      type: 'PHP',
      rootPath: proxy.transport.root ? String(proxy.transport.root) : undefined,
      // Caddy writes `unix/` + an absolute path, so the prefix leaves a double slash
      socket: dial.startsWith('unix/') ? dial.replace(/^unix\/+/, '/') : undefined,
    };
  }

  if (proxy) {
    // a bucket origin is proxied over TLS on 443; a local app is a loopback port
    const localPort = dial.match(/^(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)$/);
    if (localPort?.[1]) return { type: 'NODEJS', port: Number(localPort[1]) };

    const host = dial.replace(/:\d+$/, '');
    return { type: 'STATIC', origin: host || undefined };
  }

  const files = handlers.find((handler) => handler?.handler === 'file_server');
  if (files) {
    const vars = handlers.find((handler) => handler?.handler === 'vars' && handler?.root);
    return { type: 'STATIC', rootPath: vars?.root ? String(vars.root) : undefined };
  }

  // redirects, ACME plumbing, anything else: not an application
  return null;
}

/** Hostnames a route matches. */
export function routeHosts(route: any): string[] {
  return (Array.isArray(route?.match) ? route.match : []).flatMap((matcher: any) =>
    Array.isArray(matcher?.host)
      ? matcher.host.filter((host: any) => typeof host === 'string')
      : [],
  );
}

/** A hostname that is a route but never an application. */
export function isNotAnApp(host: string): boolean {
  const name = host.trim().toLowerCase();
  // the wildcard is how every app under a domain resolves — it is not one itself
  return !name || name.startsWith('*.') || (PANEL_HOST !== '' && name === PANEL_HOST);
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
 * What one node is actually serving: its live Caddy routes joined with the pm2
 * process behind each proxied port. pm2 processes with no route are reported
 * too, under a `<name>.pm2.local` placeholder host.
 */
export async function scanNode(node: SshTarget): Promise<DiscoveredApp[]> {
  const [processes, config] = await Promise.all([listPm2Processes(node), getCaddyConfig(node)]);
  const byPort = new Map<number, Pm2Process>();
  for (const process of processes) {
    if (process.port) byPort.set(process.port, process);
  }

  const routes: any[] = config?.apps?.http?.servers?.commitbase?.routes ?? [];
  const apps: DiscoveredApp[] = [];
  const claimed = new Set<string>();
  const seen = new Set<string>();

  for (const route of routes) {
    const target = classifyRoute(route);
    if (!target) continue;

    for (const host of routeHosts(route)) {
      const domain = host.trim().toLowerCase();
      if (isNotAnApp(domain) || seen.has(domain)) continue;
      seen.add(domain);

      const process = target.port ? byPort.get(target.port) : undefined;
      if (process) claimed.add(process.name);

      const runtime: Runtime = target.port
        ? process
          ? 'PM2'
          : 'CADDY_PROXY'
        : target.type === 'PHP'
          ? 'CADDY_PHP'
          : 'CADDY_STATIC';

      apps.push({
        name: process?.name || domain,
        domain,
        runtime,
        type: target.type,
        status: process
          ? process.status === 'online'
            ? 'RUNNING'
            : 'STOPPED'
          : target.port
            ? 'ERROR' // routed to a port nothing is listening on
            : 'RUNNING',
        port: target.port,
        processName: process?.name,
        rootPath: target.rootPath || (target.port ? undefined : path.join(APPS_ROOT_DIR, domain)),
      });
    }
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

/** Every node, so the inventory is the whole estate rather than one box. */
export async function scanServerApps(): Promise<DiscoveredApp[]> {
  const nodes = await allServers();
  const apps: DiscoveredApp[] = [];

  for (const node of nodes) {
    try {
      apps.push(...(await scanNode(node)));
    } catch (error: any) {
      console.error(`Could not scan ${node.hostname}:`, error?.message);
    }
  }

  return apps;
}

/**
 * Reconcile the scan into the applications table, keyed on the domain. Synced
 * apps land unassigned (no organization) — a superadmin assigns them
 * afterwards, the same way domain sync works.
 */
export async function syncServerApps(userId: string, node?: SshTarget): Promise<AppSyncResult> {
  const discovered = node ? await scanNode(node) : await scanServerApps();
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
 * Control a pm2-managed app discovered by the sync. Apps we deploy ourselves keep
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
