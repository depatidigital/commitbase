import * as http from 'http';
import { getStaticSiteBaseUrl } from './s3Service';
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
  method: 'GET' | 'PUT' | 'POST',
  path: string,
  body?: any,
): Promise<{ status: number; body: string }> {
  const stream = await forwardTcp(server, CADDY_ADMIN_HOST, CADDY_ADMIN_PORT);
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

type RuntimeTarget = {
  type: 'runtime';
  upstreamPort: number;
};

type StaticTarget = {
  type: 'static';
  redirectUrl: string;
};

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
};

// Files on this box, served straight from disk — what a file-based site block
// with `root` + `file_server` did before it was adopted into the API.
type FilesTarget = {
  type: 'files';
  root: string;
};

type Target = RuntimeTarget | StaticTarget | BucketTarget | PhpTarget | FilesTarget;

/** null means the node did not answer — different from an empty config. */
async function fetchCaddyConfig(server: SshTarget): Promise<any | null> {
  try {
    const response = await caddyRequest(server, 'GET', '/config/');
    if (response.status >= 400) return {};
    return JSON.parse(response.body || '{}') || {};
  } catch (error: any) {
    console.error(`Could not read Caddy config from ${server.hostname}:`, error?.message);
    return null;
  }
}

async function putCaddyConfig(server: SshTarget, config: any): Promise<void> {
  const response = await caddyRequest(server, 'PUT', '/config/', config);
  if (response.status >= 400) {
    throw new Error(`Caddy rejected the config (HTTP ${response.status}): ${response.body.slice(0, 200)}`);
  }
}

/**
 * Which HTTP server block in the config holds the tenant routes.
 *
 * A box whose Caddy was set up from a Caddyfile has its sites under whatever
 * name the adapter chose — `srv0`, usually — not under ours. Writing to a
 * hardcoded `commitbase` block on such a node creates a second server that
 * fights the first for :443, and reading from it finds nothing even though the
 * box is serving dozens of sites.
 */
export function serverNameFor(config: any): string {
  const servers = config?.apps?.http?.servers ?? {};
  if (servers.commitbase) return 'commitbase';

  // the block already bound to the web ports is the one already serving traffic
  const existing = Object.entries(servers).find(([, server]: [string, any]) =>
    (Array.isArray(server?.listen) ? server.listen : []).some((address: string) =>
      /:(80|443)$/.test(String(address)),
    ),
  );

  return existing?.[0] ?? 'commitbase';
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
function buildPhpRoute(domain: string, target: PhpTarget): any {
  return {
    match: [{ host: [domain] }],
    handle: [
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

function buildRoute(domain: string, target: Target): any {
  if (target.type === 'php') return buildPhpRoute(domain, target);

  if (target.type === 'files') {
    return {
      match: [{ host: [domain] }],
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
        host: [domain],
      },
    ],
    handle: [],
  };

  if (target.type === 'runtime') {
    route.handle.push({
      handler: 'reverse_proxy',
      upstreams: [
        {
          dial: `localhost:${target.upstreamPort}`,
        },
      ],
    });
  } else if (target.type === 'bucket') {
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
      ],
    });

    route.handle.push({
      handler: 'reverse_proxy',
      transport: { protocol: 'http', tls: {} },
      headers: {
        request: {
          set: {
            Host: [target.origin],
          },
        },
      },
      upstreams: [
        {
          dial: `${target.origin}:443`,
        },
      ],
    });
  } else {
    route.handle.push({
      handler: 'redirect',
      location: target.redirectUrl,
      status_code: 308,
    });
  }

  return route;
}

/** Rewrite the route list for one hostname: drop what is there, add `target` if given. */
async function setRoute(node: SshTarget, domain: string, target: Target | null): Promise<void> {
  const existing = await fetchCaddyConfig(node);
  if (existing === null) {
    return;
  }

  const config = ensureHttpServer(existing);
  const servers = config.apps.http.servers;
  const serverName = serverNameFor(config);
  const server = servers[serverName];

  const routes: any[] = server.routes || [];
  const filteredRoutes = routes.filter((route) => {
    if (!Array.isArray(route.match)) {
      return true;
    }

    const hosts = route.match
      .flatMap((m: any) => (Array.isArray(m.host) ? m.host : []))
      .filter((h: any) => typeof h === 'string');

    return !hosts.includes(domain);
  });

  if (target) filteredRoutes.push(buildRoute(domain, target));
  server.routes = filteredRoutes;
  servers[serverName] = server;
  config.apps.http.servers = servers;

  await putCaddyConfig(node, config);
}

export async function configureCaddyForStaticApplication(
  node: SshTarget,
  applicationId: string,
  domain: string,
  bucketOrigin?: string | null
): Promise<void> {
  // R2-backed sites are proxied; older ones still redirect to their S3 URL
  if (bucketOrigin) {
    await setRoute(node, domain, {
      type: 'bucket',
      origin: bucketOrigin,
    });
    return;
  }

  const redirectUrl = getStaticSiteBaseUrl(applicationId);
  if (!redirectUrl) {
    return;
  }

  await setRoute(node, domain, {
    type: 'static',
    redirectUrl,
  });
}

/** A static site whose files uploaded but whose route did not: it is down. */
export const staticRouteError = (error: any): string =>
  `Files are in Cloudflare R2, but the Caddy route could not be set: ${error?.message ?? String(error)}`;

export async function configureCaddyForRuntimeApplication(
  node: SshTarget,
  domain: string,
  hostPort: number,
): Promise<void> {
  if (!hostPort || hostPort <= 0) {
    return;
  }

  await setRoute(node, domain, {
    type: 'runtime',
    upstreamPort: hostPort,
  });
}

export async function configureCaddyForPhpApplication(
  node: SshTarget,
  domain: string,
  root: string,
  socket: string,
): Promise<void> {
  await setRoute(node, domain, { type: 'php', root, socket });
}

/** Drop the hostname's route when the application is deleted. */
export async function removeCaddySite(node: SshTarget, domain: string): Promise<void> {
  await setRoute(node, domain, null);
}

export async function configureCaddyForFiles(node: SshTarget, domain: string, root: string): Promise<void> {
  if (!root) {
    return;
  }
  await setRoute(node, domain, { type: 'files', root });
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

/** Push a whole config back — restoring a snapshot, and nothing else. */
export async function replaceCaddyConfig(node: SshTarget, config: any): Promise<void> {
  await putCaddyConfig(node, config);
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
