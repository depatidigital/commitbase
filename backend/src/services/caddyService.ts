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

type Target = RuntimeTarget | StaticTarget;

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

function buildRoute(domain: string, target: Target): any {
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
  } else {
    route.handle.push({
      handler: 'redirect',
      location: target.redirectUrl,
      status_code: 308,
    });
  }

  return route;
}

async function upsertRoute(domain: string, target: Target): Promise<void> {
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

  const newRoute = buildRoute(domain, target);
  filteredRoutes.push(newRoute);
  server.routes = filteredRoutes;
  servers[serverName] = server;
  config.apps.http.servers = servers;

  await putCaddyConfig(config);
}

export async function configureCaddyForStaticApplication(applicationId: string, domain: string): Promise<void> {
  if (!CADDY_API_URL) {
    return;
  }

  const redirectUrl = getStaticSiteBaseUrl(applicationId);
  if (!redirectUrl) {
    return;
  }

  await upsertRoute(domain, {
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

  await upsertRoute(domain, {
    type: 'runtime',
    upstreamPort: hostPort,
  });
}

