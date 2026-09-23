import path from 'path';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { createApplicationWithSource, dropOrphanSources, setSourceOrganization } from '../lib/sources';
import { setAppBindings, zonesFor } from '../lib/appDomains';
import { readServe, type Serve } from './hostRouteService';
import { exec, type SshTarget } from '../lib/runner';
import { lockfileManager, parseEnvFile } from '../lib/projectDetect';
import { sealEnv } from '../lib/appEnv';
import { allServers } from '../lib/servers';
import { getCaddyConfig, allRoutesOf } from './caddyService';

/** The panel's own hostname is a route like any other, and is not a tenant app. */
export const PANEL_HOST = (process.env.PANEL_HOST || process.env.FRONTEND_HOST || '').trim().toLowerCase();

export const APPS_ROOT_DIR = process.env.APPS_ROOT_DIR || '/var/www/html';

export type Runtime = 'PM2' | 'CADDY_PHP' | 'CADDY_STATIC' | 'CADDY_PROXY' | 'DOCKER';

/** One container on the node, from `docker ps`. Discovery only — nothing here starts or stops one. */
export type DockerContainer = { name: string; image: string; status: string; ports: number[] };

/**
 * The containers running on the node, with the host ports they publish.
 * Empty when there is no docker on the box, which is the usual case.
 */
export async function listDockerContainers(node: SshTarget): Promise<DockerContainer[]> {
  const { stdout } = await exec(node, ['docker', 'ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'], {
    timeout: 20_000,
  }).catch(() => ({ stdout: '' }) as any);
  return parseDockerPs(String(stdout));
}

/**
 * `docker ps` rows → containers and the host ports they publish. A published
 * port reads as `0.0.0.0:8082->80/tcp` or `127.0.0.1:8082->80/tcp`; the host
 * port is the one nginx proxies to, so that is the one kept.
 */
export function parseDockerPs(stdout: string): DockerContainer[] {
  const out: DockerContainer[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [name, image, status, ports] = line.split('\t');
    if (!name) continue;
    const published = [...String(ports ?? '').matchAll(/(?:^|,\s*)(?:[\d.:\[\]]*:)?(\d+)->/g)].map((m) => Number(m[1]));
    out.push({ name, image: image ?? '', status: status ?? '', ports: [...new Set(published)].filter((p) => p > 0) });
  }
  return out;
}

export type DiscoveredApp = {
  name: string;
  /** where it answers — hostnames, or a hostname and a path; merged by mergeSameSite */
  bindings: SyncBinding[];
  /** what Caddy sends its requests to, as the route says — undefined when it cannot be told (a bucket) */
  serve?: Serve | undefined;
  runtime: Runtime;
  type: 'NODEJS' | 'PHP' | 'STATIC';
  status: 'RUNNING' | 'STOPPED' | 'ERROR';
  port?: number | undefined;
  processName?: string | undefined;
  /** pm2's: what it runs (pm2StartCommand) */
  startCommand?: string | undefined;
  rootPath?: string | undefined;
  configPath?: string | undefined;
  memory?: string | undefined;
  cpu?: string | undefined;
  uptime?: string | undefined;
  /** the git remote its folder was cloned from, when it is a checkout */
  repository?: string | undefined;
  branch?: string | undefined;
  /**
   * The folder its code is pulled into: the git checkout root (the served
   * folder is often its public/), else the folder itself. Apps with the same
   * one on a node share a source.
   */
  checkout?: string | undefined;
  /** a hostname split by path (routeParts), else undefined */
  routing?: RoutePart[] | undefined;
};

/** A hostname and a path under it ("" = the whole name). */
export type SyncBinding = { host: string; path: string };
export const bindingKey = (b: SyncBinding) => `${b.host} ${b.path}`;
export const bindingLabel = (b: SyncBinding) => `${b.host}${b.path}`;

/** What a found app runs, to know it by: its pm2 process, its target, else its folder. Pure. */
export function identityKeys(app: { processName?: string | null | undefined; serve?: unknown; runtime?: string | null; rootPath?: string | null | undefined }): string[] {
  const serve = readServe(app.serve);
  return [
    ...(app.processName ? [`pm2 ${app.processName}`] : []),
    ...(serve ? [`serve ${serve.kind} ${'port' in serve ? serve.port : 'root' in serve ? serve.root : ''}`] : []),
    ...(app.runtime && app.rootPath ? [`dir ${app.runtime} ${app.rootPath}`] : []),
  ];
}

/**
 * An app's name from its folder: the project it is, not the web root inside it
 * (`/srv/x/web/dist` → web, `/var/www/html/panelweb/public` → panelweb). A
 * folder that names nothing (`/var/www/html`) gives null. Pure.
 */
export function folderName(dir: string | undefined): string | null {
  if (!dir) return null;
  const clean = dir.replace(/\/+$/, '');
  const project = /\/(dist|build|out|public|public_html|htdocs|www)$/.test(clean) ? path.posix.dirname(clean) : clean;
  const name = path.posix.basename(project);
  return !name || ['html', 'www', 'htdocs', 'public_html', 'var', 'srv', 'home'].includes(name) ? null : name;
}

/**
 * Bindings served by the same thing — the same process port, the same folder
 * — are one app on several names and paths: a multi-site CMS behind five
 * domains, say. They become one app with all of them. Pure.
 */
export function mergeSameSite(apps: DiscoveredApp[]): DiscoveredApp[] {
  const sites = new Map<string, DiscoveredApp>();
  const merged: DiscoveredApp[] = [];
  for (const app of apps) {
    const placeholder = app.bindings.some((b) => b.host.endsWith('.pm2.local'));
    // nothing known about what serves it: nothing proves two names are one app
    const key = placeholder
      ? null
      : app.serve
        ? [app.runtime, JSON.stringify(app.serve)].join('|')
        : app.rootPath || app.port
          ? [app.runtime, app.rootPath ?? '', app.port ?? ''].join('|')
          : null;
    const site = key ? sites.get(key) : undefined;
    if (site) {
      site.bindings = [...site.bindings, ...app.bindings];
      continue;
    }
    if (key) sites.set(key, app);
    merged.push(app);
  }
  return merged;
}

/** A single-target route that answers unknown paths with index.html (Caddyfile `try_files {path} /index.html`). Pure. */
export const routeSpa = (route: any): boolean => /"try_files":\[[^\]]*index\.html/.test(JSON.stringify(route ?? null));

export type AppSyncResult = {
  /** databases their .env files named, attached to them this sync */
  databasesLinked?: number;
  discovered: number;
  created: number;
  updated: number;
  apps: Array<DiscoveredApp & { action: 'created' | 'updated' }>;
  errors?: string[];
};

export type Pm2Process = {
  name: string;
  status: string;
  pid?: number | undefined;
  port?: number | undefined;
  cwd?: string | undefined;
  memory?: string | undefined;
  cpu?: string | undefined;
  uptime?: string | undefined;
  /** what pm2 runs, as someone would type it in its folder */
  startCommand?: string | undefined;
  /** the node pm2 runs it with, e.g. `24.13.0` — a build must use the same one */
  nodeVersion?: string | undefined;
};

/**
 * What a pm2 process runs, as one would type it in its folder: `npm run
 * start`, `node dist/server.js --port 3000`. From pm2's own record of it — the
 * script (a package manager, or a file) and its arguments. Pure.
 */
export function pm2StartCommand(env: { pm_exec_path?: unknown; args?: unknown; exec_interpreter?: unknown; pm_cwd?: unknown }): string | undefined {
  const script = typeof env.pm_exec_path === 'string' ? env.pm_exec_path : '';
  if (!script) return undefined;
  const args = Array.isArray(env.args) ? env.args.map(String).join(' ') : typeof env.args === 'string' ? env.args : '';
  const base = path.posix.basename(script).replace(/\.(c?js|cmd)$/, '');
  // npm, pnpm, yarn, bun (or their cli.js): the package manager and its arguments
  const manager = ['npm', 'npm-cli', 'npx', 'npx-cli', 'pnpm', 'yarn', 'bun'].includes(base) ? base.replace('-cli', '') : null;
  const cwd = typeof env.pm_cwd === 'string' ? env.pm_cwd : '';
  const file = cwd && script.startsWith(`${cwd.replace(/\/+$/, '')}/`) ? path.posix.relative(cwd, script) : script;
  const interpreter = typeof env.exec_interpreter === 'string' && env.exec_interpreter !== 'none' ? path.posix.basename(env.exec_interpreter) : '';
  const command = manager ?? (interpreter ? `${interpreter} ${file}` : file);
  return [command, args].filter(Boolean).join(' ');
}

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

/**
 * argv for `pm2 <args>` on a node. pm2 is usually installed under nvm, and a
 * non-interactive SSH exec never sources nvm — so its bin dirs go on PATH first.
 */
function pm2(args: string[]): string[] {
  return ['sh', '-c', 'for d in "$HOME"/.nvm/versions/node/*/bin; do PATH="$d:$PATH"; done; exec pm2 "$@"', 'sh', ...args];
}

/** `pm2 jlist` on a node — an empty list when pm2 is missing, so a box without it just shows its Caddy side. */
export async function listPm2Processes(node: SshTarget): Promise<Pm2Process[]> {
  try {
    const { stdout } = await exec(node, pm2(['jlist']), { maxBuffer: 10 * 1024 * 1024 });
    const raw = JSON.parse(stdout || '[]');

    return (Array.isArray(raw) ? raw : [])
      .map((process: any) => {
        const env = process.pm2_env || {};
        // no PORT in the env: the `-p 1500` / `--port 5506` a start script was given
        const args = Array.isArray(env.args) ? env.args.join(' ') : String(env.args ?? '');
        const portRaw = env.PORT ?? env.env?.PORT ?? args.match(/(?:^|\s)(?:-p|--port)[=\s]+(\d+)/)?.[1];
        const port = Number(portRaw);

        return {
          name: String(process.name || ''),
          status: String(env.status || 'unknown'),
          pid: Number(process.pid) > 0 ? Number(process.pid) : undefined,
          port: Number.isFinite(port) && port > 0 ? port : undefined,
          cwd: env.pm_cwd || env.cwd,
          memory: humanBytes(process.monit?.memory || 0),
          cpu: process.monit?.cpu != null ? `${process.monit.cpu}%` : undefined,
          uptime: env.pm_uptime ? humanUptime(env.pm_uptime) : undefined,
          startCommand: pm2StartCommand(env),
          nodeVersion: typeof env.node_version === 'string' ? env.node_version : undefined,
        };
      })
      .filter((process) => process.name);
  } catch {
    return [];
  }
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

  const proxies = handlers.filter((handler) => handler?.handler === 'reverse_proxy');
  // a path-split site (`/ws*` → its socket server, everything else → the app)
  // has several proxies; the app the hostname is is the catch-all.
  // ponytail: "catch-all" = the last one, which is where the Caddyfile adapter
  // sorts the unmatched handle. Read the matchers if hand-written JSON breaks that.
  const proxy =
    proxies.find((handler) => handler?.transport?.protocol === 'fastcgi') ?? proxies[proxies.length - 1];
  const dial = String(proxy?.upstreams?.[0]?.dial ?? '');

  // `root /srv/site` in a Caddyfile is a vars handler; a placeholder
  // ("{http.vars.root}") is not a path
  const varsRoot = handlers.find((handler) => handler?.handler === 'vars' && handler?.root)?.root;
  const realPath = (value: unknown) => (typeof value === 'string' && value.startsWith('/') ? value : undefined);

  if (proxy?.transport?.protocol === 'fastcgi') {
    return {
      type: 'PHP',
      // php_fastcgi's own root first, else the site's `root`
      rootPath: realPath(proxy.transport.root) ?? realPath(varsRoot),
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
    return { type: 'STATIC', rootPath: realPath(varsRoot) ?? realPath(files.root) };
  }

  // redirects, ACME plumbing, anything else: not an application
  return null;
}

/** One path of a hostname split by path: what serves it. `path` null = everything else. */
/** `spa`: a static part that answers unknown paths with its index.html (a front-end router's). */
export type RoutePart = { path: string | null; proxy?: string; root?: string; spa?: boolean };

/**
 * How a site split by path is served, in the order Caddy tries it — an API
 * behind `/api/*` beside a static front end in `web/dist`, say: one hostname,
 * two parts, and classifyRoute can only name one. null when one thing serves
 * all of it; a PHP site (its file_server and its FastCGI are one app) too.
 * Pure — the self-check drives it with config JSON.
 */
export function routeParts(route: any): RoutePart[] | null {
  const parts: RoutePart[] = [];
  let php = false;
  const realPath = (value: unknown) => (typeof value === 'string' && value.startsWith('/') ? value : undefined);
  // `root` is set by a vars handler earlier in the same subroute, and holds for
  // what follows it there and below
  const visit = (handlers: any[], path: string | null, scope: { root?: string | undefined; spa?: boolean }) => {
    for (const handler of Array.isArray(handlers) ? handlers : []) {
      if (handler?.handler === 'vars' && realPath(handler.root)) scope.root = handler.root;
      if (handler?.handler === 'reverse_proxy') {
        if (handler?.transport?.protocol === 'fastcgi') php = true;
        const dial = String(handler?.upstreams?.[0]?.dial ?? '');
        if (dial) parts.push({ path, proxy: dial });
      }
      if (handler?.handler === 'file_server') {
        const root = realPath(handler.root) ?? scope.root;
        parts.push({ path, ...(root && { root }), ...(scope.spa && { spa: true }) });
      }
      if (handler?.handler === 'subroute') {
        const inner = { ...scope };
        for (const nested of Array.isArray(handler.routes) ? handler.routes : []) {
          const matchers = Array.isArray(nested?.match) ? nested.match : [];
          const paths = matchers.flatMap((m: any) => (Array.isArray(m?.path) ? m.path : []));
          // try_files ending in index.html: every unknown path gets the app's page (Caddyfile `try_files {path} /index.html`)
          if (matchers.some((m: any) => Array.isArray(m?.file?.try_files) && m.file.try_files.some((f: unknown) => /(^|\/)index\.html$/.test(String(f))))) {
            inner.spa = true;
          }
          visit(nested?.handle, paths.length ? paths.join(', ') : path, inner);
        }
      }
    }
  };
  visit(route?.handle, null, {});
  return !php && parts.length > 1 ? parts : null;
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

/**
 * Ports something is listening on, straight from the node.
 *
 * pm2's own port is only known when the process was started with a PORT in its
 * environment, which most are not — so "no pm2 process on this port" says
 * nothing about whether the site is up. Asking the kernel does: a port with a
 * listener is being served, whoever started it.
 *
 * An empty map means the question could not be answered (no `ss`, no
 * permission), and the caller treats that as "assume it is fine" rather than
 * marking every proxied site broken.
 */
export async function listListeningPorts(node: SshTarget): Promise<Map<number, number | undefined>> {
  try {
    const { stdout } = await exec(node, ['ss', '-H', '-ltnp'], { timeout: 10_000 });
    return parseListeners(stdout);
  } catch {
    return new Map();
  }
}

/**
 * `ss -H -ltnp` output → port → the pid listening on it. The pid is only there
 * when ss can see the socket's owner (root, or the same user) — a port with no
 * pid is still a served port.
 */
export function parseListeners(stdout: string): Map<number, number | undefined> {
  const ports = new Map<number, number | undefined>();

  for (const line of stdout.split(/\r?\n/)) {
    // "LISTEN 0 511 127.0.0.1:5503 0.0.0.0:* users:(("node",pid=1234,fd=20))"
    // — the local address is the 4th column
    const columns = line.trim().split(/\s+/);
    const port = Number(String(columns[3] ?? '').split(':').pop());
    if (!Number.isFinite(port) || port <= 0) continue;

    const pid = Number(line.match(/pid=(\d+)/)?.[1]);
    if (!ports.get(port)) ports.set(port, pid > 0 ? pid : undefined);
  }

  return ports;
}

/** pid → parent pid for every process on the node, or an empty map when ps fails. */
export async function listParentPids(node: SshTarget): Promise<Map<number, number>> {
  const parents = new Map<number, number>();
  try {
    const { stdout } = await exec(node, ['ps', '-eo', 'pid=,ppid='], { timeout: 10_000 });
    for (const line of stdout.split(/\r?\n/)) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid! > 0 && ppid! >= 0) parents.set(pid!, ppid!);
    }
  } catch {
    // exact pid matches still work without it
  }
  return parents;
}

/**
 * The pm2 process a pid belongs to. pm2 records the pid it spawned, but an app
 * started as `pnpm start` / `npm exec next` listens from a descendant several
 * levels down (pnpm → sh → tsx → node), so walk up the parents to it.
 */
export function pm2OwnerOf<T>(pid: number, byPid: Map<number, T>, parents: Map<number, number>): T | undefined {
  for (let current: number | undefined = pid, depth = 0; current && current > 1 && depth < 16; depth++) {
    const owner = byPid.get(current);
    if (owner) return owner;
    current = parents.get(current);
  }
  return undefined;
}

/**
 * Working directory of each pid, from /proc — for a proxied process that is
 * where its code lives, and the only place that is written down. A pid we may
 * not read (another user's, without root) or one running from `/` (a container
 * proxy) is left out.
 */
export async function processCwds(node: SshTarget, pids: number[]): Promise<Map<number, string>> {
  const cwds = new Map<number, string>();
  if (!pids.length) return cwds;

  try {
    const { stdout } = await exec(
      node,
      ['sh', '-c', 'for p; do printf "%s %s\\n" "$p" "$(readlink /proc/$p/cwd 2>/dev/null)"; done', 'sh', ...pids.map(String)],
      { timeout: 10_000 },
    );

    for (const line of stdout.split(/\r?\n/)) {
      const [pid, ...rest] = line.trim().split(' ');
      const cwd = rest.join(' ');
      if (Number(pid) > 0 && cwd.startsWith('/') && cwd !== '/') cwds.set(Number(pid), cwd);
    }
  } catch {
    // no directories is not a failed scan
  }

  return cwds;
}

/**
 * A remote as the panel stores repositories: HTTPS, no credentials. A checkout
 * made with a token often has it in the URL (`https://user:ghp_…@github.com/…`)
 * — that must never reach the database. SSH remotes become their HTTPS form,
 * the one a connected account's token works on. null for anything else
 * (a local path, file://). Pure.
 */
export function repositoryFromRemote(remote: string | undefined): string | null {
  const url = String(remote ?? '').trim();
  const scp = url.match(/^[\w.-]+@([\w.-]+):(?!\/)(.+)$/); // git@github.com:owner/repo.git
  if (scp) return `https://${scp[1]}/${scp[2]}`;

  const full = url.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+)$/i);
  return full ? `https://${full[1]}/${full[2]}` : null;
}

export type FolderState = { exists: boolean; repository?: string; branch?: string; checkout?: string };

/**
 * Whether each folder is there, and for a git checkout its remote and branch —
 * one SSH round trip. `safe.directory=*`: the folders usually belong to another
 * user, and git would otherwise refuse to read them. null when the node could
 * not be asked, so a failed probe never reads as "every folder is gone".
 */
export async function probeFolders(node: SshTarget, dirs: string[]): Promise<Map<string, FolderState> | null> {
  const found = new Map<string, FolderState>();
  if (!dirs.length) return found;

  try {
    const { stdout } = await exec(
      node,
      [
        'sh',
        '-c',
        'for d; do printf "%s\\t%s\\t%s\\t%s\\t%s\\n" "$d" "$([ -d "$d" ] && echo 1)" "$(git -c safe.directory="*" -C "$d" config --get remote.origin.url 2>/dev/null)" "$(git -c safe.directory="*" -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)" "$(git -c safe.directory="*" -C "$d" rev-parse --show-toplevel 2>/dev/null)"; done',
        'sh',
        ...dirs,
      ],
      { timeout: 20_000 },
    );

    for (const line of stdout.split(/\r?\n/)) {
      const [dir, exists, remote, branch, toplevel] = line.split('\t');
      if (!dir) continue;
      const repository = repositoryFromRemote(remote) ?? undefined;
      found.set(dir, {
        exists: exists === '1',
        ...(repository && { repository }),
        // a detached checkout says "HEAD" — that is not a branch to deploy
        ...(repository && branch && branch !== 'HEAD' && { branch }),
        // the checkout root, remote or not
        ...(toplevel?.startsWith('/') && { checkout: toplevel.replace(/\/+$/, '') }),
      });
    }
    return found;
  } catch {
    return null;
  }
}

/**
 * What one node is actually serving: its live Caddy routes joined with the pm2
 * process behind each proxied port. pm2 processes with no route are reported
 * too, under a `<name>.pm2.local` placeholder host.
 */
export async function scanNode(node: SshTarget): Promise<DiscoveredApp[]> {
  const [processes, config, listening, parents] = await Promise.all([
    listPm2Processes(node),
    getCaddyConfig(node),
    listListeningPorts(node),
    listParentPids(node),
  ]);
  const byPort = new Map<number, Pm2Process>();
  const byPid = new Map<number, Pm2Process>();
  for (const process of processes) {
    // a stopped cron entry can share its app's PORT env — the online one serves it
    if (process.port && (!byPort.has(process.port) || process.status === 'online')) byPort.set(process.port, process);
    if (process.pid) byPid.set(process.pid, process);
  }

  const pids = [...new Set([...listening.values()].filter((pid): pid is number => !!pid))];
  const cwds = await processCwds(node, pids);

  const routes = allRoutesOf(config);
  const apps: DiscoveredApp[] = [];
  const claimed = new Set<string>();
  const seen = new Set<string>();
  const guessed = new Set<DiscoveredApp>();

  for (const route of routes) {
    const target = classifyRoute(route);
    if (!target) continue;
    // a hostname split by path is one app per part: `/api/*` → the process, the rest → files
    const parts = routeParts(route);

    for (const host of routeHosts(route)) {
      const domain = host.trim().toLowerCase();
      if (isNotAnApp(domain) || seen.has(domain)) continue;
      seen.add(domain);

      type Spec = { path: string; port?: number | undefined; type: DiscoveredApp['type']; rootPath?: string | undefined; socket?: string | undefined; origin?: string | undefined; spa?: boolean | undefined };
      const specs: Spec[] = parts
        ? parts.flatMap((part): Spec[] => {
            const local = part.proxy?.match(/^(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)$/);
            if (local) return [{ path: part.path ?? '', port: Number(local[1]), type: 'NODEJS' }];
            // proxied off the box (a bucket): not an app of this node
            if (part.proxy) return [];
            return part.root ? [{ path: part.path ?? '', type: 'STATIC', rootPath: part.root, spa: part.spa }] : [];
          })
        : [{ path: '', ...target, spa: routeSpa(route) }];

      for (const spec of specs) {
        // pm2 rarely has the PORT in its env, so the kernel's listener pid is how
        // a proxied port is traced back to its process and directory
        const pid = spec.port ? listening.get(spec.port) : undefined;
        const process = spec.port ? byPort.get(spec.port) ?? (pid ? pm2OwnerOf(pid, byPid, parents) : undefined) : undefined;
        if (process) claimed.add(process.name);

        const runtime: Runtime = spec.port ? (process ? 'PM2' : 'CADDY_PROXY') : spec.type === 'PHP' ? 'CADDY_PHP' : 'CADDY_STATIC';
        const knownRoot = spec.rootPath || process?.cwd || (pid ? cwds.get(pid) : undefined);
        // a bucket-proxied site has no directory on the node; a PHP/static route
        // that does not say gets the conventional folder — checked below, kept only if it is there
        const guessedRoot = knownRoot || spec.port || spec.origin ? undefined : path.posix.join(APPS_ROOT_DIR, domain);
        // what Caddy sends it to — the route composer rebuilds a shared name's route from these
        const serve: Serve | undefined = spec.port
          ? { kind: 'proxy', port: spec.port }
          : spec.type === 'PHP' && knownRoot && spec.socket
            ? { kind: 'php', root: knownRoot, socket: spec.socket }
            : spec.type === 'STATIC' && spec.rootPath
              ? { kind: 'files', root: spec.rootPath, spa: !!spec.spa }
              : undefined;

        // what it is called: its pm2 process; else its folder (web/dist → web,
        // panelweb/public → panelweb) — one site's many hostnames share it, and
        // the first of them in Caddy's file says nothing; else where it answers
        const folder = folderName(knownRoot || guessedRoot);
        const app: DiscoveredApp = {
          name: process?.name || folder || `${domain}${spec.path}`,
          bindings: [{ host: domain, path: spec.path }],
          runtime,
          type: spec.type,
          // pm2 knows a process's state; the kernel knows whether the port is
          // actually served. Only a port with no listener is an error — a process
          // pm2 cannot match to a port is not evidence of anything.
          status: process
            ? process.status === 'online'
              ? 'RUNNING'
              : 'STOPPED'
            : spec.port && listening.size > 0 && !listening.has(spec.port)
              ? 'ERROR'
              : 'RUNNING',
          port: spec.port,
          processName: process?.name,
          startCommand: process?.startCommand,
          rootPath: knownRoot || guessedRoot,
          serve,
          memory: process?.memory,
          cpu: process?.cpu,
          uptime: process?.uptime,
        };
        apps.push(app);
        if (guessedRoot) guessed.add(app);
      }
    }
  }

  // a socket server or cron job running from a routed app's directory is part
  // of that app, not an app of its own
  const routedDirs = new Set(apps.map((app) => app.rootPath).filter(Boolean));

  for (const process of processes) {
    if (claimed.has(process.name) || (process.cwd && routedDirs.has(process.cwd))) continue;

    apps.push({
      name: process.name,
      bindings: [{ host: `${process.name}.pm2.local`, path: '' }],
      runtime: 'PM2',
      type: 'NODEJS',
      status: process.status === 'online' ? 'RUNNING' : 'STOPPED',
      port: process.port,
      processName: process.name,
      startCommand: process.startCommand,
      rootPath: process.cwd,
      memory: process.memory,
      cpu: process.cpu,
      uptime: process.uptime,
    });
  }

  // is each folder really there, and where did its code come from
  const folders = await probeFolders(node, [...new Set(apps.map((app) => app.rootPath).filter((dir): dir is string => !!dir))]);
  for (const app of apps) {
    const state = app.rootPath ? folders?.get(app.rootPath) : undefined;
    // a PHP/static site is its files: a route to a folder that is not there
    // serves nothing, whatever the route says (a probe that failed proves nothing)
    if (state && !state.exists && !app.port) app.status = 'ERROR';
    // a guess that is not on disk is no folder at all
    if (guessed.has(app) && state && !state.exists) app.rootPath = undefined;
    if (state?.repository) Object.assign(app, { repository: state.repository, branch: state.branch });
    // not a checkout (or the node was not asked): the folder itself is what its apps share
    if (app.rootPath) app.checkout = state?.checkout ?? app.rootPath;
  }

  const merged = mergeSameSite(apps);
  // one process behind two ports (an app and its socket server) is two apps: told apart by port
  const byName = new Map<string, number>();
  for (const app of merged) byName.set(app.name, (byName.get(app.name) ?? 0) + 1);
  for (const app of merged) if ((byName.get(app.name) ?? 0) > 1 && app.port) app.name = `${app.name} :${app.port}`;
  return merged;
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
 * Reconcile the scan into the applications table, keyed on the hostnames. Synced
 * apps land unassigned (no organization) — a superadmin assigns them
 * afterwards, the same way domain sync works.
 */
export async function syncServerApps(userId: string, node?: SshTarget): Promise<AppSyncResult> {
  // Without a node, do every node one at a time rather than one flat scan: each
  // row has to be stamped with the box it was found on, and a node that fails
  // must not take the others down with it.
  if (!node) {
    const totals: AppSyncResult = { discovered: 0, created: 0, updated: 0, apps: [] };
    const errors: string[] = [];

    for (const server of await allServers()) {
      try {
        const result = await syncServerApps(userId, server);
        totals.discovered += result.discovered;
        totals.created += result.created;
        totals.updated += result.updated;
        totals.databasesLinked = (totals.databasesLinked ?? 0) + (result.databasesLinked ?? 0);
        totals.apps.push(...result.apps);
        if (result.errors) errors.push(...result.errors);
      } catch (error: any) {
        errors.push(`${server.hostname}: ${error?.message ?? 'scan failed'}`);
      }
    }

    if (errors.length) totals.errors = errors;
    return totals;
  }

  const discovered = await scanNode(node);
  const result: AppSyncResult = { discovered: discovered.length, created: 0, updated: 0, apps: [] };
  const errors: string[] = [];

  const include = { _count: { select: { deployments: true } }, source: { select: { repository: true } } } as const;
  // Who holds each (hostname, path) found, and which found app each of those
  // rows is "at home" in: the one it shares the most bindings with.
  const allKeys = discovered.flatMap((app) => app.bindings.map(bindingKey));
  const holding = await prisma.appDomain.findMany({
    where: { OR: discovered.flatMap((app) => app.bindings.map((b) => ({ host: b.host, path: b.path }))) },
    select: { host: true, path: true, application: { include } },
  });
  type Row = (typeof holding)[number]['application'];
  const siteOf = new Map(discovered.flatMap((app, i) => app.bindings.map((b) => [bindingKey(b), i] as const)));
  const holders = new Map<string, Row>();
  for (const { host, path: at, application } of holding) holders.set(bindingKey({ host, path: at }), application);

  // The panel's own apps show up in the scan too — their route is on the box.
  // Stamping a runtime on one turns it into an "imported" app the panel then
  // refuses to deploy, and guesses a directory it never had. Created here (no
  // runtime) or deployed from here (has deployments): not ours to touch.
  const isPanels = (row: Row) => !row.runtime || row._count.deployments > 0;

  // A row is recognized by what it runs before the names it holds: the pm2
  // process, or the same target. A site split into apps keeps its row where the
  // process (with its env and databases) is — the front end gets a new one,
  // however the names were held before.
  // Strongest first, for every app, before a weaker one is tried: two processes
  // from one folder (an app and its socket server) are told apart by name,
  // never matched by the folder they share.
  const nodeRows = await prisma.application.findMany({ where: { serverId: node.id, runtime: { not: null } }, include });
  const identity = new Map<number, Row>();
  const claimedRow = new Set<string>();
  for (const level of ['pm2 ', 'serve ', 'dir ']) {
    for (const [i, app] of discovered.entries()) {
      if (identity.has(i)) continue;
      const key = identityKeys(app).find((k) => k.startsWith(level));
      if (!key) continue;
      const row = nodeRows.find((candidate) => !isPanels(candidate) && !claimedRow.has(candidate.id) && identityKeys(candidate).includes(key));
      if (row) {
        identity.set(i, row);
        claimedRow.add(row.id);
      }
    }
  }
  // the project already serving a hostname — for a part of it with no folder of its own
  const hostSources = new Map<string, { id: string; organizationId: string | null }>();
  // the app on the whole name leads: its project is the name's
  for (const { host, path: at, application } of [...holding].sort((a, b) => a.path.length - b.path.length)) {
    if (application.sourceId && !hostSources.has(host) && (at === '' || !holding.some((h) => h.host === host && h.path === ''))) {
      hostSources.set(host, { id: application.sourceId, organizationId: application.organizationId });
    }
  }
  const sourceOfHost = (bindings: SyncBinding[]) => bindings.map((b) => hostSources.get(b.host)).find(Boolean);

  // otherwise, the found app a holding row shares the most bindings with
  const overlap = new Map<string, Map<number, number>>();
  for (const [key, row] of holders) {
    if (claimedRow.has(row.id)) continue;
    const site = siteOf.get(key)!;
    const counts = overlap.get(row.id) ?? new Map<number, number>();
    counts.set(site, (counts.get(site) ?? 0) + 1);
    overlap.set(row.id, counts);
  }
  const homeOf = new Map([...overlap].map(([id, counts]) => [id, [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0]]));

  for (const [i, app] of discovered.entries()) {
    const fields = {
      // where it was found, so the node's page can list it before anyone has
      // assigned it to an organization
      serverId: node.id,
      runtime: app.runtime,
      processName: app.processName ?? null,
      // what runs it on the box: pm2 says — a pm2 that did not answer this time forgets nothing
      ...(app.startCommand && { startCommand: app.startCommand }),
      rootPath: app.rootPath ?? null,
      configPath: app.configPath ?? null,
      // a split is apps now, each with its own bindings: nothing left to keep here
      routing: Prisma.DbNull,
      // what Caddy sends it to; not read from the route (a bucket's): kept as it was
      ...(app.serve && { serve: app.serve as Prisma.InputJsonValue }),
      status: app.status,
      port: app.port ?? null,
      memory: app.memory ?? null,
      cpu: app.cpu ?? null,
      uptime: app.uptime ?? null,
      lastSyncedAt: new Date(),
    };
    const label = app.bindings.map(bindingLabel).join(', ');

    try {
      const held = [...new Map(app.bindings.flatMap((b) => (holders.has(bindingKey(b)) ? [holders.get(bindingKey(b))!] : [])).map((row) => [row.id, row])).values()]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

      // the row that stays: the one that runs the same thing, else one someone
      // assigned, else the oldest — of the holders at home here
      const imported = held.filter((row) => !isPanels(row) && !claimedRow.has(row.id) && homeOf.get(row.id) === i);
      const existing = identity.get(i) ?? imported.find((row) => row.organizationId) ?? imported[0] ?? null;
      // merged into it: rows of the same org (or none) — never another tenant's
      const same = (row: Row) => !row.organizationId || !existing?.organizationId || row.organizationId === existing.organizationId;
      if (held.some((row) => !isPanels(row) && row !== existing && !claimedRow.has(row.id) && !same(row))) {
        errors.push(`${label}: served the same way as an app of another organization — kept apart`);
      }
      // a binding held by a panel app or another tenant's stays where it is;
      // one held by an app recognized elsewhere moves here (it is this app's route now)
      const free = app.bindings.filter((b) => {
        const row = holders.get(bindingKey(b));
        return !row || row === existing || (!isPanels(row) && same(row));
      });
      if (free.length === 0) continue;

      const merging = imported.filter((row) => row !== existing && same(row));
      if (merging.length) {
        // one app now: its databases come along, its duplicate rows go (the
        // server is untouched — nothing is torn down)
        const ids = merging.map((row) => row.id);
        await prisma.database.updateMany({ where: { applicationId: { in: ids } }, data: { applicationId: existing!.id } });
        await prisma.application.deleteMany({ where: { id: { in: ids } } });
      }
      // bindings another app held give way to this one
      await prisma.appDomain.deleteMany({
        where: { OR: free.map((b) => ({ host: b.host, path: b.path })), ...(existing && { applicationId: { not: existing.id } }) },
      });
      const zones = await zonesFor(free.map((b) => b.host));
      const names = free.map((b, n) => ({ host: b.host, path: b.path, domainId: zones[n]!.domainId }));

      // The source is the checkout: every app served from it shares one, and
      // pulling it updates them all. No folder known: a source of its own.
      const shared = app.checkout ? await checkoutSource(node.id, app) : null;
      // an app keeps its org, and an app of another org is never moved onto
      // (or given) this source's — that would hand one tenant another's app
      const owner = existing?.organizationId ?? null;
      const joins = shared && (!owner || !shared.organizationId || shared.organizationId === owner);
      if (shared && !joins) {
        errors.push(`${label}: its folder ${app.checkout} is shared with another organization's app — kept apart`);
      }
      if (joins && owner && !shared!.organizationId) {
        await setSourceOrganization([shared!.id], owner);
      }

      const sibling = sourceOfHost(app.bindings);
      if (existing) {
        // named by the sync after a hostname: renamed as what it is now (a split's
        // part, a process); a name someone gave it stays
        const autoNamed = holding.some((h) => h.application.id === existing.id && h.host === existing.name) || app.bindings.some((b) => b.host === existing.name);
        await prisma.application.update({
          where: { id: existing.id },
          data: {
            ...fields,
            ...(joins && { sourceId: shared!.id }),
            // no folder of its own: with the project serving its name, if that is its org's
            ...(!shared && sibling && sibling.id !== existing.sourceId && (!sibling.organizationId || !existing.organizationId || sibling.organizationId === existing.organizationId) && { sourceId: sibling.id }),
            ...(autoNamed && existing.name !== app.name && { name: app.name }),
          },
        });
        // exactly the bindings it is served on now
        await setAppBindings(existing.id, names);
        if (!joins && existing.sourceId && !existing.source?.repository && app.repository) {
          await prisma.source.update({
            where: { id: existing.sourceId },
            data: { repository: app.repository, branch: app.branch ?? 'main' },
          });
        }
        result.updated += 1;
        result.apps.push({ ...app, bindings: free, action: 'updated' });
      } else if (joins) {
        // a new app on a checkout that already has an owner is that owner's
        await prisma.application.create({
          data: {
            name: app.name,
            type: app.type,
            userId,
            ...fields,
            domains: { create: names },
            sourceId: shared!.id,
            organizationId: shared!.organizationId,
          },
        });
        result.created += 1;
        result.apps.push({ ...app, bindings: free, action: 'created' });
      } else if (!shared && sourceOfHost(app.bindings)) {
        // no folder to go by, on a name another app already serves: the same project
        const sibling = sourceOfHost(app.bindings)!;
        await prisma.application.create({
          data: { name: app.name, type: app.type, userId, ...fields, domains: { create: names }, sourceId: sibling.id, organizationId: sibling.organizationId },
        });
      } else {
        await createApplicationWithSource(
          { name: app.name, type: app.type, userId, ...fields, domains: { create: names } },
          app.repository ? { repository: app.repository, branch: app.branch ?? 'main' } : {},
        );
        result.created += 1;
        result.apps.push({ ...app, bindings: free, action: 'created' });
      }
    } catch (error: any) {
      errors.push(`${label}: ${error?.message || 'sync failed'}`);
    }
  }

  // `<name>.pm2.local` rows are the sync's own placeholders: one whose process
  // is gone goes unless someone assigned it; one whose process is now found
  // behind a route goes regardless — the routed app is that process, org and all.
  // Only when pm2 answered, so a failed `pm2 jlist` does not wipe them all.
  if (discovered.some((app) => app.processName)) {
    const routed = discovered
      .filter((app) => app.processName && !app.bindings.some((b) => b.host.endsWith('.pm2.local')))
      .map((app) => app.processName!);
    const placeholderHosts = allKeys.map((key) => key.split(' ')[0]!).filter((host) => host.endsWith('.pm2.local'));
    await prisma.application.deleteMany({
      where: {
        serverId: node.id,
        domains: { some: {}, every: { host: { endsWith: '.pm2.local', notIn: placeholderHosts } } },
        OR: [{ organizationId: null }, { processName: { in: routed } }],
      },
    });
  }
  // sources left without apps: moved onto a shared checkout, or deleted above
  await dropOrphanSources();

  // their .env files: mirrored into the panel, and the databases they name attached
  try {
    result.databasesLinked = await readAppEnvs(node);
  } catch (error: any) {
    errors.push(`databases: ${error?.message || 'could not read the apps\' .env files'}`);
  }

  if (errors.length) result.errors = errors;
  return result;
}

export type DatabaseRef = { name: string; engine?: 'POSTGRESQL' | 'MYSQL' | undefined; host?: string | undefined };

const engineOf = (value?: string): DatabaseRef['engine'] =>
  /^(postgres|postgresql|pgsql)\b/i.test(value ?? '') ? 'POSTGRESQL' : /^(mysql|mariadb)\b/i.test(value ?? '') ? 'MYSQL' : undefined;

/**
 * The databases an app's .env names — by URL (DATABASE_URL, Prisma's
 * DIRECT_URL) or by parts (Laravel's DB_*, libpq's PG*, MYSQL_*): the name,
 * and the engine and host when it says. Only names leave here, never a
 * password. Pure.
 */
export function databaseRefs(env: Record<string, string>): DatabaseRef[] {
  const refs: DatabaseRef[] = [];
  for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
    try {
      const url = new URL(env[key] ?? '');
      const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      if (name) refs.push({ name, engine: engineOf(url.protocol), host: url.hostname || undefined });
    } catch {
      // not a URL
    }
  }
  const name = env.DB_DATABASE || env.DB_NAME || env.PGDATABASE || env.MYSQL_DATABASE;
  if (name) {
    refs.push({
      name,
      engine: engineOf(env.DB_CONNECTION) ?? (env.PGDATABASE ? 'POSTGRESQL' : env.MYSQL_DATABASE ? 'MYSQL' : undefined),
      host: env.DB_HOST || env.PGHOST || env.MYSQL_HOST || undefined,
    });
  }
  return refs;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * How a Node app in a folder is built: its package.json `build` script, run by
 * the package manager its lockfile says. undefined when it has none. Pure.
 */
export function buildCommandFrom(packageJson: string, files: string[]): string | undefined {
  let scripts: Record<string, unknown> = {};
  try {
    scripts = JSON.parse(packageJson)?.scripts ?? {};
  } catch {
    return undefined;
  }
  if (typeof scripts.build !== 'string' || !scripts.build.trim()) return undefined;
  const manager = lockfileManager((name) => files.includes(name)) ?? 'npm';
  return manager === 'yarn' ? 'yarn build' : `${manager} run build`;
}

/**
 * What the sync reads in each imported app's folder: a Node app's build
 * command (buildCommandFrom), and the .env files — the app folder's, its parent's
 * (Laravel serves public/) and the checkout's, the most specific winning.
 * Mirrored into the app's env (sealed, like every app's), read-only in the
 * panel: the file on the server is the truth, and the next sync overwrites.
 * The databases they name are attached; one attached to an app stays with it.
 */
async function readAppEnvs(node: SshTarget): Promise<number> {
  const servers = await prisma.databaseServer.findMany({
    where: { serverId: node.id },
    select: { id: true, engine: true, host: true, appHost: true },
  });

  const apps = await prisma.application.findMany({
    where: { serverId: node.id, runtime: { not: null }, rootPath: { not: null } },
    select: { id: true, type: true, organizationId: true, rootPath: true, source: { select: { path: true } } },
  });

  let linked = 0;
  for (const app of apps) {
    const dirs = [...new Set([app.source?.path, path.posix.dirname(app.rootPath!), app.rootPath].filter((dir): dir is string => !!dir))];
    // one read per app; the most specific file last, so its values win
    const { stdout } = await exec(
      node,
      ['sh', '-c', 'for d; do [ -r "$d/.env" ] && { cat -- "$d/.env"; echo; }; done; true', 'sh', ...dirs],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
    ).catch(() => ({ stdout: '' }));

    // a Node app's build: its own folder's package.json, else the checkout's
    // a static site's project is the folder its output sits in (web/ for web/dist)
    if (app.type === 'NODEJS' || app.type === 'STATIC') {
      const project = app.type === 'STATIC' ? path.posix.dirname(app.rootPath!) : app.rootPath!;
      const pkg = await exec(
        node,
        ['sh', '-c', 'for d; do if [ -r "$d/package.json" ]; then ls -- "$d"; echo "---"; cat -- "$d/package.json"; exit 0; fi; done; true', 'sh', project, ...(app.source?.path ? [app.source.path] : [])],
        { timeout: 15_000, maxBuffer: 1024 * 1024 },
      ).catch(() => ({ stdout: '' }));
      const [listing = '', json = ''] = pkg.stdout.split(/^---$/m);
      await prisma.application.update({
        where: { id: app.id },
        data: { buildCommand: buildCommandFrom(json, listing.split(/\r?\n/).map((line) => line.trim())) ?? null },
      });
    }

    if (!stdout.trim()) continue;
    const env = Object.fromEntries(parseEnvFile(stdout));
    await prisma.application.update({ where: { id: app.id }, data: { envVars: sealEnv(env) } });

    for (const ref of databaseRefs(env)) {
      // the host it connects to must be one of these servers — this box, or the address it is known by
      const candidates = servers.filter(
        (server) =>
          (!ref.engine || server.engine === ref.engine) &&
          (!ref.host || LOCAL_HOSTS.has(ref.host) || ref.host === server.host || ref.host === server.appHost),
      );
      if (candidates.length === 0) continue;
      const found = await prisma.database.findMany({
        where: { databaseServerId: { in: candidates.map((server) => server.id) }, dbName: ref.name, applicationId: null },
        select: { id: true, organizationId: true },
      });
      // the same name on two servers: nothing proves which one — left for someone to attach
      if (found.length !== 1) continue;
      await prisma.database.update({
        where: { id: found[0]!.id },
        data: { applicationId: app.id, ...(!found[0]!.organizationId && app.organizationId && { organizationId: app.organizationId }) },
      });
      linked++;
    }
  }
  return linked;
}

/**
 * The source of a checkout on a node — found, or made. What the scan read
 * there (remote, branch) is the truth for an imported checkout, so it is
 * written back each sync.
 */
async function checkoutSource(serverId: string, app: DiscoveredApp) {
  const code = app.repository ? { repository: app.repository, branch: app.branch ?? 'main' } : {};
  return prisma.source.upsert({
    where: { serverId_path: { serverId, path: app.checkout! } },
    create: { serverId, path: app.checkout!, ...code },
    update: code,
  });
}

/**
 * Control a pm2-managed app discovered by the sync. Apps we deploy ourselves keep
 * going through DeploymentService — this only covers processes pm2 owns.
 */
export async function controlPm2Process(
  node: SshTarget,
  processName: string,
  action: 'start' | 'stop' | 'restart'
): Promise<{ success: boolean; output: string }> {
  try {
    const { stdout } = await exec(node, pm2([action, processName]), { maxBuffer: 5 * 1024 * 1024 });
    return { success: true, output: stdout || '' };
  } catch (error: any) {
    return { success: false, output: error?.stderr || error?.message || `pm2 ${action} failed` };
  }
}

/**
 * Remove a process from pm2 for good: `delete`, then `save` — without the save
 * `pm2 resurrect` brings it back on the next reboot. Throws with pm2's words.
 */
export async function deletePm2Process(node: SshTarget, processName: string): Promise<void> {
  try {
    await exec(node, pm2(['delete', processName]), { maxBuffer: 5 * 1024 * 1024 });
  } catch (error: any) {
    // already gone (deleted by hand, or a stale row): what delete wanted is true
    const output = `${error?.stderr ?? ''}${error?.stdout ?? ''}${error?.message ?? ''}`;
    if (!/Process or Namespace .* not found/i.test(output)) throw error;
  }
  await exec(node, pm2(['save']), { maxBuffer: 5 * 1024 * 1024 });
}

/**
 * Follow a pm2 app's log: the last `lines` lines, then each new one as pm2
 * writes it, until `signal` aborts. Nothing is buffered — every chunk goes to
 * `onOutput`. Resolves on abort, rejects if pm2 exits on its own.
 */
export function followPm2Logs(
  node: SshTarget,
  processName: string,
  type: 'combined' | 'out' | 'error',
  lines: number,
  onOutput: (text: string) => void,
  signal: AbortSignal
): Promise<unknown> {
  const only = type === 'out' ? ['--out'] : type === 'error' ? ['--err'] : [];
  // Not --raw: keep pm2's `0|name |` prefix, green for stdout and red for
  // stderr, as in a terminal. FORCE_COLOR because pm2 goes plain without a TTY.
  return exec(node, ['env', 'FORCE_COLOR=1', ...pm2(['logs', processName, '--lines', String(lines), ...only])], {
    onOutput,
    signal,
    maxBuffer: 0,
    // backstop only: the route aborts well before this
    timeout: 2 * 60 * 60_000,
  });
}
