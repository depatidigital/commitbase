import * as http from 'http';
import { forwardTcp, type SshTarget } from '../lib/runner';

/**
 * Caddy's admin API has no authentication of its own — its whole security model
 * is that it listens on loopback and nothing else can reach it. So the address
 * is not configurable: it is always the node's own 127.0.0.1:2019, reached
 * through an SSH channel to that node, and the SSH key is the credential.
 *
 * Anything that puts this endpoint on a public interface hands over every site
 * on the box, so there is deliberately no environment variable to point it
 * somewhere else.
 */
const CADDY_ADMIN_HOST = '127.0.0.1';
const CADDY_ADMIN_PORT = 2019;
const REQUEST_TIMEOUT_MS = 15_000;

/** One request to a node's admin API, over the pooled SSH connection. */
async function caddyRequest(
  server: SshTarget,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: any,
): Promise<{ status: number; body: string }> {
  // A node whose :80/:443 still belong to another web server is set up with
  // Caddy installed but stopped (install.sh), so the admin port is simply not
  // there. Said plainly here, because "connection refused" sends people looking
  // at the network rather than at the box's own nginx.
  const stream = await forwardTcp(server, CADDY_ADMIN_HOST, CADDY_ADMIN_PORT).catch((error: any) => {
    const refused = /ECONNREFUSED|Connection refused|administratively prohibited|open failed/i.test(
      error?.message || String(error),
    );
    throw refused
      ? new Error(
          `Caddy is not running on ${server.hostname}. If another web server still has :80/:443 there, sync the node's apps and migrate them to Caddy first.`,
        )
      : error;
  });
  const payload = body === undefined ? null : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        // the Host header is for Caddy's own admin origin check, not routing —
        // the socket is already the tunnel to that node
        host: CADDY_ADMIN_HOST,
        port: CADDY_ADMIN_PORT,
        method,
        path,
        timeout: REQUEST_TIMEOUT_MS,
        createConnection: () => stream as any,
        ...(payload && {
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }),
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => {
          stream.end();
          resolve({ status: response.statusCode ?? 0, body: text });
        });
      },
    );

    request.on('timeout', () => {
      request.destroy();
      stream.end();
      reject(new Error(`Caddy admin API on ${server.hostname} timed out`));
    });

    request.on('error', (error) => {
      stream.end();
      reject(new Error(`Caddy admin API on ${server.hostname}: ${error.message}`));
    });

    if (payload) request.write(payload);
    request.end();
  });
}

/**
 * Behaviour an adopted site needs kept, because dropping it changes what the
 * site does rather than how it is written: an upload limit, a long-running
 * request, a response streamed rather than buffered. Stored on the serve, so
 * it survives every later recomposition of the hostname.
 */
export type ServeTuning = {
  /** client_max_body_size, in bytes */
  maxBodyBytes?: number | undefined;
  /** proxy_read_timeout, as nginx wrote it (Caddy takes the same "300s") */
  readTimeout?: string | undefined;
  /** proxy_buffering off — send each write on as it arrives */
  streaming?: boolean | undefined;
  /** paths nginx answered with `deny all` (RE2 patterns): 403 here too, never served */
  deny?: string[] | undefined;
};

type RuntimeTarget = {
  type: 'runtime';
  upstreamPort: number;
} & ServeTuning;

// R2-backed site: Caddy proxies the hostname to the bucket's public host and
// Cloudflare caches the answers at the edge.
type BucketTarget = {
  type: 'bucket';
  origin: string;
};

// PHP: file_server over the docroot, *.php handed to the org's FPM pool.
type PhpTarget = {
  type: 'php';
  root: string;
  socket: string;
} & ServeTuning;

// Files on this box, served straight from disk — what a file-based site block
// with `root` + `file_server` did before it was adopted into the API.
type FilesTarget = {
  type: 'files';
  root: string;
};

/**
 * One hostname split by path, in the order Caddy tries it: `/api/*` to a local
 * port, the rest a folder of files (`spa`: unknown paths get its index.html).
 * The one part with no path is the catch-all, last.
 */
export type SplitPart = { path: string | null; port?: number | undefined; root?: string | undefined; spa?: boolean | undefined };
type SplitTarget = {
  type: 'split';
  parts: SplitPart[];
};

// A hostname's route already composed from every app bound to it (hostRouteService).
type ComposedTarget = {
  type: 'composed';
  handle: any[];
};

// Nothing deployed yet: a small page saying the site is set up and waits for its first deploy
type PlaceholderTarget = {
  type: 'placeholder';
};

export type Target = RuntimeTarget | BucketTarget | PhpTarget | FilesTarget | SplitTarget | ComposedTarget | PlaceholderTarget;

/** The page a host shows before its app's first deploy — self-contained, no assets to fetch. */
const PLACEHOLDER_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{http.request.host}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a}main{text-align:center;padding:24px}h1{font-size:22px;margin:0 0 8px}p{margin:0;color:#64748b}span{display:inline-block;width:10px;height:10px;border-radius:50%;background:#22c55e;margin-right:8px}</style></head><body><main><h1><span></span>{http.request.host} is ready</h1><p>The site is set up and waiting for its first deploy.</p></main></body></html>`;

/** What one part does: proxy to the port, or serve the folder. */
function partHandle(part: SplitPart): any[] {
  if (part.port) return [{ handler: 'reverse_proxy', upstreams: [{ dial: `127.0.0.1:${part.port}` }] }];
  return [
    {
      handler: 'subroute',
      routes: [
        { handle: [{ handler: 'vars', root: part.root }] },
        // what the Caddyfile's `try_files {path} /index.html` becomes
        ...(part.spa
          ? [
              {
                match: [{ file: { try_files: ['{http.request.uri.path}', '/index.html'] } }],
                handle: [{ handler: 'rewrite', uri: '{http.matchers.file.relative}' }],
              },
            ]
          : []),
        { handle: [{ handler: 'file_server' }] },
      ],
    },
  ];
}

/** The split as the handle of one route — the same shape the Caddyfile adapter writes for `handle` blocks. */
function buildSplitHandle(parts: SplitPart[]): any[] {
  return [
    {
      handler: 'subroute',
      routes: parts.map((part) => ({
        ...(part.path && { match: [{ path: part.path.split(/,\s*/) }] }),
        handle: partHandle(part),
        terminal: true,
      })),
    },
  ];
}

/**
 * null means the node did not answer or answered with an error — never an
 * empty config: an error read as `{}` and written back would wipe every site.
 */
async function fetchCaddyConfig(server: SshTarget): Promise<any | null> {
  try {
    const response = await caddyRequest(server, 'GET', '/config/');
    if (response.status >= 400) {
      console.error(`Could not read Caddy config from ${server.hostname}: HTTP ${response.status} ${response.body.slice(0, 200)}`);
      return null;
    }
    // a Caddy with nothing loaded answers `null`
    return JSON.parse(response.body || '{}') || {};
  } catch (error: any) {
    console.error(`Could not read Caddy config from ${server.hostname}:`, error?.message);
    return null;
  }
}

async function writeCaddy(server: SshTarget, method: 'POST' | 'PATCH', path: string, body: any): Promise<void> {
  const response = await caddyRequest(server, method, path, body);
  if (response.status >= 400) {
    throw new Error(`Caddy rejected the config (HTTP ${response.status}): ${response.body.slice(0, 200)}`);
  }
}

/**
 * Swap in a whole config — only for a snapshot restore, or a node with no HTTP
 * server block yet. Not PUT /config/: PUT means "create", and answers 409
 * "key already exists" on any node that has a config.
 */
export const loadCaddyConfig = (server: SshTarget, config: any) => writeCaddy(server, 'POST', '/load', config);

// Route changes are read-modify-write: two at once on one node would each drop
// the other's route. ponytail: in-process lock — a second backend process or a
// hand edit between the read and the write can still race; add Caddy's
// ETag/If-Match if that ever happens.
// imported late: the snapshot service imports this module
const snapshots = () => import('./caddySnapshotService');

/**
 * Keep the config a write is about to replace. Throws when it cannot be kept:
 * a change with no way back is not worth making.
 */
async function keepBefore(node: SshTarget, config: any, change: string): Promise<void> {
  await (await snapshots()).saveSnapshot(node.id, config, { reason: `before ${change}`, checkpoint: false });
}

/** Keep the config a write produced, read back from Caddy. Best effort. */
async function keepAfter(node: SshTarget, change: string, checkpoint: boolean): Promise<void> {
  try {
    const after = await fetchCaddyConfig(node);
    if (after) await (await snapshots()).saveSnapshot(node.id, after, { reason: change, checkpoint });
  } catch (error: any) {
    console.error(`Caddy config on ${node.hostname} changed (${change}) but was not snapshotted:`, error?.message);
  }
}

const nodeLocks = new Map<string, Promise<unknown>>();
function withNodeLock<T>(node: SshTarget, fn: () => Promise<T>): Promise<T> {
  const next = (nodeLocks.get(node.hostname) ?? Promise.resolve()).catch(() => {}).then(fn);
  nodeLocks.set(node.hostname, next.catch(() => {}));
  return next;
}

/**
 * Which HTTP server block in the config holds the tenant routes.
 *
 * A box whose Caddy was set up from a Caddyfile has its sites under whatever
 * name the adapter chose — `srv0`, usually — not under ours. Writing to a
 * hardcoded `larika` block on such a node creates a second server that
 * fights the first for :443, and reading from it finds nothing even though the
 * box is serving dozens of sites.
 */
export function serverNameFor(config: any): string {
  const servers = config?.apps?.http?.servers ?? {};
  if (servers.larika) return 'larika';
  // installs from before the rename keep their block under the old name
  if (servers.commitbase) return 'commitbase';

  // the block already bound to the web ports is the one already serving traffic
  const existing = Object.entries(servers).find(([, server]: [string, any]) =>
    (Array.isArray(server?.listen) ? server.listen : []).some((address: string) =>
      /:(80|443)$/.test(String(address)),
    ),
  );

  return existing?.[0] ?? 'larika';
}

/** Every route in the config, whatever server block it lives in. */
export function allRoutesOf(config: any): any[] {
  const servers = config?.apps?.http?.servers ?? {};
  return Object.values(servers).flatMap((server: any) =>
    Array.isArray(server?.routes) ? server.routes : [],
  );
}

function ensureHttpServer(config: any): any {
  const updatedConfig = config || {};

  if (!updatedConfig.apps) {
    updatedConfig.apps = {};
  }

  if (!updatedConfig.apps.http) {
    updatedConfig.apps.http = {};
  }

  if (!updatedConfig.apps.http.servers) {
    updatedConfig.apps.http.servers = {};
  }

  const servers = updatedConfig.apps.http.servers;
  const serverName = serverNameFor(updatedConfig);

  if (!servers[serverName]) {
    servers[serverName] = {
      listen: [':80', ':443'],
      routes: [],
    };
  }

  if (!Array.isArray(servers[serverName].routes)) {
    servers[serverName].routes = [];
  }

  return updatedConfig;
}

// JSON form of the Caddyfile `php_fastcgi` directive plus `file_server`.
/** `client_max_body_size` as Caddy writes it, or nothing at all. */
export function bodyLimitHandle(tuning: ServeTuning): any[] {
  return tuning.maxBodyBytes ? [{ handler: 'request_body', max_size: tuning.maxBodyBytes }] : [];
}

/**
 * `location ... { deny all; }` as Caddy writes it: a 403 before anything else
 * runs. static_response ends the chain, so a matched path never reaches the app.
 */
export function denyHandle(tuning: ServeTuning): any[] {
  if (!tuning.deny?.length) return [];
  return [
    {
      handler: 'subroute',
      routes: [{ match: tuning.deny.map((pattern) => ({ path_regexp: { pattern } })), handle: [{ handler: 'static_response', status_code: 403 }] }],
    },
  ];
}

function buildPhpRoute(hosts: string[], target: PhpTarget): any {
  return {
    match: [{ host: hosts }],
    handle: [
      ...denyHandle(target),
      ...bodyLimitHandle(target),
      {
        handler: 'subroute',
        routes: [
          { handle: [{ handler: 'vars', root: target.root }] },
          {
            match: [
              {
                file: {
                  try_files: ['{http.request.uri.path}', '{http.request.uri.path}/index.php', 'index.php'],
                  split_path: ['.php'],
                },
              },
            ],
            handle: [{ handler: 'rewrite', uri: '{http.matchers.file.relative}' }],
          },
          {
            match: [{ path: ['*.php'] }],
            handle: [
              {
                handler: 'reverse_proxy',
                transport: { protocol: 'fastcgi', root: target.root, split_path: ['.php'] },
                upstreams: [{ dial: `unix/${target.socket}` }],
              },
            ],
          },
          { handle: [{ handler: 'file_server' }] },
        ],
      },
    ],
    terminal: true,
  };
}

/** One route for all of an app's names — they are one site. */
export function buildRoute(names: string | string[], target: Target): any {
  const hosts = [names].flat();
  if (target.type === 'php') return buildPhpRoute(hosts, target);
  if (target.type === 'split') return { match: [{ host: hosts }], handle: buildSplitHandle(target.parts), terminal: true };
  if (target.type === 'composed') return { match: [{ host: hosts }], handle: target.handle, terminal: true };
  if (target.type === 'placeholder') {
    return {
      match: [{ host: hosts }],
      // 503 + Retry-After: monitors and crawlers see "not live yet", people see the page
      handle: [{ handler: 'static_response', status_code: 503, headers: { 'Content-Type': ['text/html; charset=utf-8'], 'Retry-After': ['300'] }, body: PLACEHOLDER_HTML }],
      terminal: true,
    };
  }

  if (target.type === 'files') {
    return {
      match: [{ host: hosts }],
      handle: [
        {
          handler: 'subroute',
          routes: [
            { handle: [{ handler: 'vars', root: target.root }] },
            { handle: [{ handler: 'file_server' }] },
          ],
        },
      ],
      terminal: true,
    };
  }

  const route: any = {
    match: [
      {
        host: hosts,
      },
    ],
    handle: [],
    // this hostname is fully handled here — nothing after it applies
    terminal: true,
  };

  if (target.type === 'runtime') {
    route.handle.push(...denyHandle(target), ...bodyLimitHandle(target), {
      handler: 'reverse_proxy',
      upstreams: [
        {
          dial: `localhost:${target.upstreamPort}`,
        },
      ],
      // an adopted site that waits on a slow upstream, or streams its answer
      ...(target.readTimeout && { transport: { protocol: 'http', read_timeout: target.readTimeout } }),
      ...(target.streaming && { flush_interval: -1 }),
    });
  } else if (target.type === 'bucket') {
    // `host` for a bucket of its own, `host/folder` for a site in a shared bucket
    const slash = target.origin.indexOf('/');
    const host = slash < 0 ? target.origin : target.origin.slice(0, slash);
    const folder = slash < 0 ? '' : target.origin.slice(slash);

    // object storage has no directory index, so ask for index.html explicitly
    route.handle.push({
      handler: 'subroute',
      routes: [
        {
          match: [{ path: ['*/'] }],
          handle: [{ handler: 'rewrite', path_regexp: [{ find: '/$', replace: '/index.html' }] }],
        },
        {
          // extensionless paths are pages too — /about serves /about/index.html
          match: [{ path_regexp: { pattern: '^/[^.]*[^/.]$' } }],
          handle: [{ handler: 'rewrite', path_regexp: [{ find: '$', replace: '/index.html' }] }],
        },
        // the site's folder in the shared bucket, after the index rewrites
        ...(folder ? [{ handle: [{ handler: 'rewrite', uri: `${folder}{http.request.uri}` }] }] : []),
      ],
    });

    const toBucket = {
      handler: 'reverse_proxy',
      transport: { protocol: 'http', tls: {} },
      headers: { request: { set: { Host: [host] } } },
      upstreams: [{ dial: `${host}:443` }],
    };
    route.handle.push({
      ...toBucket,
      // A page the bucket does not have (/login of a single-page app, whose
      // routes live in the browser) is the site's index.html — what a server
      // with the files would do with `try_files {path} /index.html`. Only for
      // page paths: a missing asset (/x.png) stays a 404.
      handle_response: [
        {
          match: { status_code: [404] },
          routes: [
            {
              match: [{ expression: `{http.request.orig_uri.path}.matches('^/[^.]*$')` }],
              handle: [{ handler: 'rewrite', uri: `${folder}/index.html` }, toBucket],
            },
            // anything else: the bucket's answer, as it was
            { handle: [{ handler: 'copy_response' }] },
          ],
        },
      ],
    });
  }

  return route;
}

const hostsOf = (route: any): string[] =>
  (Array.isArray(route?.match) ? route.match : [])
    .flatMap((m: any) => (Array.isArray(m?.host) ? m.host : []))
    .filter((h: any) => typeof h === 'string');

/**
 * A route that answers any hostname: no host matcher, and it either ends the
 * chain or hands the request to something that responds. Caddy tries routes in
 * order, so a host route placed after one of these is never reached.
 */
const isCatchAll = (route: any): boolean =>
  hostsOf(route).length === 0 &&
  (route?.terminal === true ||
    /"handler":"(reverse_proxy|file_server|static_response)"/.test(JSON.stringify(route?.handle ?? [])));

/**
 * `routes` with these hostnames taken out of every host matcher. A route left
 * with no hostname of its own goes; one that still serves other names keeps
 * them, and everything else about it — an imported site's route is someone's
 * hand-written config, never rebuilt. Pure.
 */
export function withoutHosts(routes: any[], names: string[]): any[] {
  const gone = new Set(names.map((name) => name.toLowerCase()));
  return routes.flatMap((route) => {
    const hosts = hostsOf(route);
    if (!hosts.some((host) => gone.has(host.toLowerCase()))) return [route];
    const match = (route.match as any[])
      .map((m) => (Array.isArray(m?.host) ? { ...m, host: m.host.filter((h: any) => !gone.has(String(h).toLowerCase())) } : m))
      // a matcher whose hosts all went would match every name — it goes, not widens
      .filter((m) => !Array.isArray(m?.host) || m.host.length > 0);
    return match.some((m) => Array.isArray(m?.host)) ? [{ ...route, match }] : [];
  });
}

/** `routes` with `name` added to every host matcher that has `beside` — the same site, one more name. Pure. */
export function withHostBeside(routes: any[], beside: string, name: string): any[] {
  return routes.map((route) =>
    hostsOf(route).includes(beside)
      ? { ...route, match: route.match.map((m: any) => (Array.isArray(m?.host) && m.host.includes(beside) ? { ...m, host: [...m.host, name] } : m)) }
      : route,
  );
}

/** `routes` with `route` inserted ahead of the first catch-all, else at the end. */
export function withRoute(routes: any[], route: any): any[] {
  const at = routes.findIndex(isCatchAll);
  return at < 0 ? [...routes, route] : [...routes.slice(0, at), route, ...routes.slice(at)];
}

type RouteChange =
  // the site's names, all served by one route to `target` (a deploy)
  | { set: string[]; target: Target }
  // these names no longer served here (a delete, a name taken off an app)
  | { drop: string[] }
  // one more name for the site already served on `beside` (an imported route stays as written)
  | { add: string; beside: string };

/**
 * Rewrite the route list for some hostnames. Only the one server block is
 * written back, so TLS, other apps and other server blocks are never touched.
 */
const changeRoutes = (node: SshTarget, change: RouteChange) => withNodeLock(node, () => changeRoutesUnlocked(node, change));

async function changeRoutesUnlocked(node: SshTarget, change: RouteChange): Promise<void> {
  const names = 'set' in change ? change.set : 'drop' in change ? change.drop : [change.add];
  const existing = await fetchCaddyConfig(node);
  if (existing === null) {
    throw new Error(`Caddy on ${node.hostname} did not return its config — route for ${names.join(', ')} left unchanged`);
  }

  const reason =
    'set' in change
      ? `route ${names.join(', ')} → ${change.target.type}`
      : 'drop' in change
        ? `route ${names.join(', ')} removed`
        : `route ${change.add} added beside ${change.beside}`;
  await keepBefore(node, existing, reason);
  // decided on the untouched config: ensureHttpServer below edits it in place
  const whole = await (await snapshots()).coversCheckpoint(node.id, existing, names);

  const hadServer = !!existing?.apps?.http?.servers?.[serverNameFor(existing)];
  const config = ensureHttpServer(existing);
  const servers = config.apps.http.servers;
  const serverName = serverNameFor(config);
  const server = servers[serverName];

  const routes: any[] = server.routes || [];
  if ('add' in change) {
    // the route may sit in another server block (a Caddyfile's); edit it where it is
    let found = false;
    for (const block of Object.values(servers) as any[]) {
      if (!Array.isArray(block?.routes) || !block.routes.some((route: any) => hostsOf(route).includes(change.beside))) continue;
      block.routes = withHostBeside(withoutHosts(block.routes, [change.add]), change.beside, change.add);
      found = true;
    }
    if (!found) throw new Error(`Caddy on ${node.hostname} has no route for ${change.beside} to add ${change.add} to`);
    await loadCaddyConfig(node, config);
    await keepAfter(node, reason, whole);
    return;
  }
  server.routes = 'set' in change ? withRoute(withoutHosts(routes, names), buildRoute(names, change.target)) : withoutHosts(routes, names);

  if (hadServer) {
    // PATCH replaces just this server block (listen, TLS policies and all,
    // as read above) — the rest of the config is not in the request at all
    await writeCaddy(node, 'PATCH', `/config/apps/http/servers/${encodeURIComponent(serverName)}`, server);
  } else {
    // no block to patch yet: load the config as read, plus the new block
    await loadCaddyConfig(node, config);
  }

  // a write onto a whole config is the new baseline — which is also how a
  // removed route leaves it, instead of the watchdog putting it back
  await keepAfter(node, reason, whole);
}

const setRoute = (node: SshTarget, hosts: string[], target: Target) => changeRoutes(node, { set: hosts, target });

/** A static site whose files uploaded but whose route did not: it is down. */
export const staticRouteError = (error: any): string =>
  `Files are in Cloudflare R2, but the Caddy route could not be set: ${error?.message ?? String(error)}`;

export async function configureCaddyForRuntimeApplication(
  node: SshTarget,
  hosts: string[],
  hostPort: number,
): Promise<void> {
  if (!hostPort || hostPort <= 0) {
    return;
  }

  await setRoute(node, hosts, {
    type: 'runtime',
    upstreamPort: hostPort,
  });
}

export async function configureCaddyForPhpApplication(
  node: SshTarget,
  hosts: string[],
  root: string,
  socket: string,
): Promise<void> {
  await setRoute(node, hosts, { type: 'php', root, socket });
}

/** One hostname's route, composed from all the apps bound to it (hostRouteService). */
export async function setHostRoute(node: SshTarget, host: string, handle: any[]): Promise<void> {
  await setRoute(node, [host], { type: 'composed', handle });
}

/** Stop serving these names — the rest of a route that also serves others stays. */
export async function removeCaddySite(node: SshTarget, ...hosts: string[]): Promise<void> {
  await changeRoutes(node, { drop: hosts });
}

/** Serve `name` exactly as `beside` is served: the same route, one more hostname. */
export async function addCaddyHost(node: SshTarget, beside: string, name: string): Promise<void> {
  await changeRoutes(node, { add: name, beside });
}

export async function configureCaddyForFiles(node: SshTarget, hosts: string[], root: string): Promise<void> {
  if (!root) {
    return;
  }
  await setRoute(node, hosts, { type: 'files', root });
}

/**
 * Hostnames Caddy is currently serving. The config lives in memory, so this is
 * the only way to know whether a reload has thrown the platform's routes away.
 */
export async function listCaddyRouteHosts(node: SshTarget): Promise<string[] | null> {
  const config = await fetchCaddyConfig(node);
  if (config === null) return null;

  const routes = allRoutesOf(config);

  return [
    ...new Set(
      routes.flatMap((route: any) =>
        (Array.isArray(route?.match) ? route.match : []).flatMap((m: any) =>
          Array.isArray(m?.host) ? m.host.filter((h: any) => typeof h === 'string') : [],
        ),
      ),
    ),
  ];
}

/** The whole live config, for snapshotting. Null when Caddy did not answer. */
export async function getCaddyConfig(node: SshTarget): Promise<any | null> {
  return fetchCaddyConfig(node);
}

/**
 * Push a whole config back — restoring a snapshot, and nothing else. What it
 * replaces is kept first, so the restore can itself be undone; what it leaves
 * is the new checkpoint, or the watchdog would heal a chosen rollback away.
 */
export async function replaceCaddyConfig(node: SshTarget, config: any, reason: string): Promise<void> {
  await withNodeLock(node, async () => {
    const before = await fetchCaddyConfig(node);
    if (before) await keepBefore(node, before, reason);
    await loadCaddyConfig(node, config);
    await keepAfter(node, reason, true);
  });
}

/** Hostnames in a config object (live or snapshotted). */
export function routeHostsOf(config: any): string[] {
  const routes = allRoutesOf(config);

  return [
    ...new Set(
      routes.flatMap((route: any) =>
        (Array.isArray(route?.match) ? route.match : []).flatMap((m: any) =>
          Array.isArray(m?.host) ? m.host.filter((h: any) => typeof h === 'string') : [],
        ),
      ),
    ),
  ];
}
