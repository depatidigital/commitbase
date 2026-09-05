import { getStaticSiteBaseUrl } from './s3Service';

const CADDY_API_URL = process.env.CADDY_API_URL || '';

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

type Target = RuntimeTarget | StaticTarget | BucketTarget | PhpTarget;

async function fetchCaddyConfig(): Promise<any | null> {
  if (!CADDY_API_URL) {
    return null;
  }

  const fetchFn: any = (globalThis as any).fetch;
  if (!fetchFn) {
    return null;
  }

  try {
    const response = await fetchFn(`${CADDY_API_URL}/config`, {
      method: 'GET',
    });

    if (!response.ok) {
      return {};
    }

    const data = await response.json();
    return data || {};
  } catch {
    return null;
  }
}

async function putCaddyConfig(config: any): Promise<void> {
  if (!CADDY_API_URL) {
    return;
  }

  const fetchFn: any = (globalThis as any).fetch;
  if (!fetchFn) {
    return;
  }

  try {
    await fetchFn(`${CADDY_API_URL}/config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(config),
    });
  } catch {
  }
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
  const serverName = 'commitbase';

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
async function setRoute(domain: string, target: Target | null): Promise<void> {
  const existing = await fetchCaddyConfig();
  if (existing === null) {
    return;
  }

  const config = ensureHttpServer(existing);
  const servers = config.apps.http.servers;
  const serverName = 'commitbase';
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

  await putCaddyConfig(config);
}

export async function configureCaddyForStaticApplication(
  applicationId: string,
  domain: string,
  bucketOrigin?: string | null
): Promise<void> {
  if (!CADDY_API_URL) {
    return;
  }

  // R2-backed sites are proxied; older ones still redirect to their S3 URL
  if (bucketOrigin) {
    await setRoute(domain, {
      type: 'bucket',
      origin: bucketOrigin,
    });
    return;
  }

  const redirectUrl = getStaticSiteBaseUrl(applicationId);
  if (!redirectUrl) {
    return;
  }

  await setRoute(domain, {
    type: 'static',
    redirectUrl,
  });
}

export async function configureCaddyForRuntimeApplication(domain: string, hostPort: number): Promise<void> {
  if (!CADDY_API_URL) {
    return;
  }

  if (!hostPort || hostPort <= 0) {
    return;
  }

  await setRoute(domain, {
    type: 'runtime',
    upstreamPort: hostPort,
  });
}

export async function configureCaddyForPhpApplication(domain: string, root: string, socket: string): Promise<void> {
  if (!CADDY_API_URL) {
    return;
  }
  await setRoute(domain, { type: 'php', root, socket });
}

/** Drop the hostname's route when the application is deleted. */
export async function removeCaddySite(domain: string): Promise<void> {
  if (!CADDY_API_URL) {
    return;
  }
  await setRoute(domain, null);
}
