import path from 'path';
import { prisma } from '../lib/prisma';
import { createApplicationWithSource, dropOrphanSources } from '../lib/sources';
import { parentDomainOf } from '../lib/scope';
import { ROOT_DIRECTORY_RE } from '../lib/appPaths';
import { exec, type SshTarget } from '../lib/runner';
import { allServers } from '../lib/servers';
import { getCaddyConfig, allRoutesOf } from './caddyService';

/** The panel's own hostname is a route like any other, and is not a tenant app. */
export const PANEL_HOST = (process.env.PANEL_HOST || process.env.FRONTEND_HOST || '').trim().toLowerCase();

export const APPS_ROOT_DIR = process.env.APPS_ROOT_DIR || '/var/www/html';

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
  /** the git remote its folder was cloned from, when it is a checkout */
  repository?: string | undefined;
  branch?: string | undefined;
  /** that checkout's root: apps sharing one are a monorepo and share a source */
  checkout?: string | undefined;
  /** the app's folder in the checkout; undefined at its root */
  rootDirectory?: string | undefined;
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
  pid?: number | undefined;
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

export type FolderState = {
  exists: boolean;
  repository?: string;
  branch?: string;
  /** the checkout's own root — apps whose folders share one are one monorepo */
  checkout?: string;
  /** the app's folder in that checkout (see PROBE_SCRIPT); undefined at its root */
  rootDirectory?: string;
};

/**
 * Per folder, one tab-separated line: the folder, 1 when it exists, the git
 * remote, the branch, the checkout's root, and the project folder — the nearest
 * one up to that root with a package.json, composer.json or requirements.txt,
 * so a site served from apps/web/dist or public/ is the project in apps/web or
 * at the root. Resolved (`pwd -P`) like git's own root, so a symlinked folder
 * still lands inside it. `safe.directory=*`: the folders usually belong to
 * another user, and git would otherwise refuse to read them. Exported for the self-check.
 */
export const PROBE_SCRIPT = [
  'for d; do',
  '  g() { git -c safe.directory="*" -C "$d" "$@" 2>/dev/null; }',
  // the root resolved the same way as the folder, so the two always compare
  '  top=$(g rev-parse --show-toplevel); [ -n "$top" ] && top=$(cd "$top" 2>/dev/null && pwd -P); project=""',
  '  real=$(cd "$d" 2>/dev/null && pwd -P)',
  '  if [ -n "$top" ] && [ -n "$real" ]; then',
  '    q="$real"',
  '    while [ -z "$project" ]; do',
  '      for f in package.json composer.json requirements.txt; do [ -e "$q/$f" ] && project="$q"; done',
  '      { [ "$q" = "$top" ] || [ "$q" = / ]; } && break',
  '      q=$(dirname "$q")',
  '    done',
  '    [ -n "$project" ] || project="$real"',
  '  fi',
  '  printf "%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$d" "$([ -d "$d" ] && echo 1)" "$(g config --get remote.origin.url)" "$(g rev-parse --abbrev-ref HEAD)" "$top" "$project"',
  'done',
].join('\n');

/**
 * An app's folder in its checkout, as a rootDirectory: undefined at the
 * checkout's root, or for anything outside it or not a plain folder path. Pure.
 */
export function rootDirectoryIn(checkout: string, project: string): string | undefined {
  const relative = path.posix.relative(checkout, project);
  return relative && ROOT_DIRECTORY_RE.test(relative) ? relative : undefined;
}

/** Checkouts more than one of these apps is in — monorepos. Pure. */
export function monorepoCheckouts(apps: Array<{ checkout?: string | undefined }>): string[] {
  const count = new Map<string, number>();
  for (const app of apps) if (app.checkout) count.set(app.checkout, (count.get(app.checkout) ?? 0) + 1);
  return [...count].filter(([, n]) => n > 1).map(([checkout]) => checkout);
}

/** PROBE_SCRIPT's output → folder states. Pure. */
export function parseProbe(stdout: string): Map<string, FolderState> {
  const found = new Map<string, FolderState>();
  for (const line of stdout.split(/\r?\n/)) {
    const [dir, exists, remote, branch, checkout, project] = line.split('\t');
    if (!dir) continue;
    const repository = repositoryFromRemote(remote) ?? undefined;
    const rootDirectory = checkout && project ? rootDirectoryIn(checkout, project) : undefined;
    found.set(dir, {
      exists: exists === '1',
      ...(repository && { repository }),
      // a detached checkout says "HEAD" — that is not a branch to deploy
      ...(repository && branch && branch !== 'HEAD' && { branch }),
      ...(checkout && { checkout }),
      ...(rootDirectory && { rootDirectory }),
    });
  }
  return found;
}

/**
 * Whether each folder is there, and for a git checkout its remote, branch, and
 * where in the checkout it is — one SSH round trip. null when the node could
 * not be asked, so a failed probe never reads as "every folder is gone".
 */
export async function probeFolders(node: SshTarget, dirs: string[]): Promise<Map<string, FolderState> | null> {
  if (!dirs.length) return new Map();

  try {
    const { stdout } = await exec(node, ['sh', '-c', PROBE_SCRIPT, 'sh', ...dirs], { timeout: 20_000 });
    return parseProbe(stdout);
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

    for (const host of routeHosts(route)) {
      const domain = host.trim().toLowerCase();
      if (isNotAnApp(domain) || seen.has(domain)) continue;
      seen.add(domain);

      // pm2 rarely has the PORT in its env, so the kernel's listener pid is how
      // a proxied port is traced back to its process and directory
      const pid = target.port ? listening.get(target.port) : undefined;
      const process = target.port ? byPort.get(target.port) ?? (pid ? pm2OwnerOf(pid, byPid, parents) : undefined) : undefined;
      if (process) claimed.add(process.name);

      const runtime: Runtime = target.port
        ? process
          ? 'PM2'
          : 'CADDY_PROXY'
        : target.type === 'PHP'
          ? 'CADDY_PHP'
          : 'CADDY_STATIC';

      const knownRoot = target.rootPath || process?.cwd || (pid ? cwds.get(pid) : undefined);
      // a bucket-proxied site has no directory on the node; a PHP/static route
      // that does not say gets the conventional folder — checked below, kept only if it is there
      const guessedRoot = knownRoot || target.port || target.origin ? undefined : path.posix.join(APPS_ROOT_DIR, domain);

      const app: DiscoveredApp = {
        name: process?.name || domain,
        domain,
        runtime,
        type: target.type,
        // pm2 knows a process's state; the kernel knows whether the port is
        // actually served. Only a port with no listener is an error — a process
        // pm2 cannot match to a port is not evidence of anything.
        status: process
          ? process.status === 'online'
            ? 'RUNNING'
            : 'STOPPED'
          : target.port && listening.size > 0 && !listening.has(target.port)
            ? 'ERROR'
            : 'RUNNING',
        port: target.port,
        processName: process?.name,
        rootPath: knownRoot || guessedRoot,
        memory: process?.memory,
        cpu: process?.cpu,
        uptime: process?.uptime,
      };
      apps.push(app);
      if (guessedRoot) guessed.add(app);
    }
  }

  // a socket server or cron job running from a routed app's directory is part
  // of that app, not an app of its own
  const routedDirs = new Set(apps.map((app) => app.rootPath).filter(Boolean));

  for (const process of processes) {
    if (claimed.has(process.name) || (process.cwd && routedDirs.has(process.cwd))) continue;

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

  // is each folder really there, and where did its code come from
  const folders = await probeFolders(node, [...new Set(apps.map((app) => app.rootPath).filter((dir): dir is string => !!dir))]);
  for (const app of apps) {
    const state = app.rootPath ? folders?.get(app.rootPath) : undefined;
    // a PHP/static site is its files: a route to a folder that is not there
    // serves nothing, whatever the route says (a probe that failed proves nothing)
    if (state && !state.exists && !app.port) app.status = 'ERROR';
    // a guess that is not on disk is no folder at all
    if (guessed.has(app) && state && !state.exists) app.rootPath = undefined;
    if (state?.repository) {
      Object.assign(app, { repository: state.repository, branch: state.branch, checkout: state.checkout, rootDirectory: state.rootDirectory });
    }
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
  // link each app to the Domain it sits under, so the domain knows its apps
  const domains = await prisma.domain.findMany({ select: { id: true, name: true } });

  // Checkouts holding more than one app → the source they share (null until
  // decided). The one an imported app of it already has, oldest first, so a
  // re-sync never shuffles them; else the first app's, as it is created.
  // ponytail: an app that leaves its monorepo keeps the shared source — it only says where the code came from.
  const monorepos = new Map<string, string | null>();
  for (const checkout of monorepoCheckouts(discovered)) monorepos.set(checkout, null);
  const monorepoSource = async (app: DiscoveredApp): Promise<string | null> => {
    if (!app.checkout || !monorepos.has(app.checkout)) return null;
    const known = monorepos.get(app.checkout);
    if (known) return known;
    const oldest = await prisma.application.findFirst({
      where: {
        serverId: node.id,
        domain: { in: discovered.filter((other) => other.checkout === app.checkout).map((other) => other.domain) },
        // imported and never deployed from the panel — the panel's own apps keep theirs
        runtime: { not: null },
        deployments: { none: {} },
        sourceId: { not: null },
      },
      orderBy: { createdAt: 'asc' },
      select: { sourceId: true },
    });
    if (oldest?.sourceId) monorepos.set(app.checkout, oldest.sourceId);
    return oldest?.sourceId ?? null;
  };

  for (const app of discovered) {
    const fields = {
      // where it was found, so the node's page can list it before anyone has
      // assigned it to an organization
      serverId: node.id,
      runtime: app.runtime,
      processName: app.processName ?? null,
      rootPath: app.rootPath ?? null,
      configPath: app.configPath ?? null,
      status: app.status,
      port: app.port ?? null,
      memory: app.memory ?? null,
      cpu: app.cpu ?? null,
      uptime: app.uptime ?? null,
      // where in its checkout the app is; the checkout's root when not in a monorepo folder
      rootDirectory: app.rootDirectory ?? null,
      lastSyncedAt: new Date(),
    };

    try {
      // one checkout with several apps in it is a monorepo: they share a source
      const shared = await monorepoSource(app);
      const existing = await prisma.application.findUnique({
        where: { domain: app.domain },
        include: { _count: { select: { deployments: true } }, source: { select: { repository: true } } },
      });
      const domainId = parentDomainOf(app.domain, domains)?.id ?? null;
      let applicationId: string;

      // The panel's own apps show up in the scan too — their route is on the
      // box. Stamping a runtime on one turns it into an "imported" app the panel
      // then refuses to deploy, and guesses a directory it never had. Created
      // here (no runtime) or deployed from here (has deployments): not ours.
      if (existing && (!existing.runtime || existing._count.deployments > 0)) continue;

      let sourceId: string | null;
      if (existing) {
        await prisma.application.update({
          where: { id: existing.id },
          // fills rows synced before the link / the repo existed; never moves a set one
          data: {
            ...fields,
            ...(!existing.domainId && domainId && { domainId }),
            // joins its monorepo's source; its own is swept below once nothing uses it
            ...(shared && shared !== existing.sourceId && { sourceId: shared }),
          },
        });
        sourceId = shared ?? existing.sourceId;
        const repositoryKnown = shared && shared !== existing.sourceId ? false : !!existing.source?.repository;
        if (sourceId && !repositoryKnown && app.repository) {
          // never over one already set: a shared source keeps what its first app said
          await prisma.source.updateMany({
            where: { id: sourceId, repository: null },
            data: { repository: app.repository, branch: app.branch ?? 'main' },
          });
        }
        applicationId = existing.id;
        result.updated += 1;
        result.apps.push({ ...app, action: 'updated' });
      } else {
        const data = { name: app.name, domain: app.domain, type: app.type, userId, domainId, ...fields };
        const created = shared
          ? await prisma.application.create({ data: { ...data, sourceId: shared } })
          : await createApplicationWithSource(data, app.repository ? { repository: app.repository, branch: app.branch ?? 'main' } : {});
        sourceId = created.sourceId;
        applicationId = created.id;
        result.created += 1;
        result.apps.push({ ...app, action: 'created' });
      }
      // the first app of a monorepo seen: its source is the one the others join
      if (app.checkout && sourceId && monorepos.has(app.checkout) && !monorepos.get(app.checkout)) {
        monorepos.set(app.checkout, sourceId);
      }

    } catch (error: any) {
      errors.push(`${app.domain}: ${error?.message || 'sync failed'}`);
    }
  }

  // `<name>.pm2.local` rows are the sync's own placeholders: one whose process
  // is gone, or is now found behind a route, goes — unless someone assigned it.
  // Only when pm2 answered, so a failed `pm2 jlist` does not wipe them all.
  if (discovered.some((app) => app.processName)) {
    await prisma.application.deleteMany({
      where: {
        serverId: node.id,
        organizationId: null,
        domain: { endsWith: '.pm2.local', notIn: discovered.map((app) => app.domain) },
      },
    });
  }
  // sources left without an app: the placeholders' above, and those of apps that joined a monorepo's
  await dropOrphanSources();

  if (errors.length) result.errors = errors;
  return result;
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
  await exec(node, pm2(['delete', processName]), { maxBuffer: 5 * 1024 * 1024 });
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
