import * as dns from 'dns/promises';
import { exec, execRoot, type SshTarget } from '../lib/runner';
import { sitesOf, type NginxSite } from '../lib/nginxConfig';
import { buildRoute, getCaddyConfig, loadCaddyConfig, type Target } from './caddyService';
import type { Serve } from './hostRouteService';

/**
 * Adopting a box that already serves its sites with nginx.
 *
 * Two steps, deliberately apart. Reading is safe and repeatable: it parses the
 * configuration and says what each site would become. Switching is one
 * operation with a verified result and a way back — nginx's own configuration
 * is never edited or removed, so putting it back is starting it again.
 *
 * Caddy is not running while nginx holds :80/:443 (install.sh leaves it
 * stopped), so the whole configuration is assembled first and loaded in one
 * request straight after nginx stops. The gap is that one request long.
 */

/** Where Debian and Ubuntu keep the enabled sites. */
const SITE_DIRS = ['/etc/nginx/sites-enabled', '/etc/nginx/conf.d'];
/** Marks each file in the concatenated output, so a parse error names a file. */
const FILE_MARK = '#__larika_file__ ';

export type SitePlan = {
  site: NginxSite;
  /** what the panel would store for it */
  serve: Serve | null;
  /** hostnames whose DNS does not point at this node — ACME would fail for them */
  danglingHosts: string[];
  /** why it cannot be migrated, when it cannot */
  blocked: string | null;
};

export type MigrationPlan = {
  /** the nginx files that were read */
  files: string[];
  sites: SitePlan[];
  /** true when nothing blocks the switch */
  ready: boolean;
};

/** Read the enabled site files off the node, concatenated with a marker per file. */
export async function readNginxFiles(node: SshTarget): Promise<Map<string, string>> {
  // one command, not one per file: a box with forty sites is forty round trips
  const script = SITE_DIRS.map(
    (dir) => `for f in ${dir}/*; do [ -f "$f" ] || continue; echo "${FILE_MARK}$f"; cat -- "$f"; done 2>/dev/null`,
  ).join('; ');
  const { stdout } = await execRoot(node, ['sh', '-c', `${script}; true`], { timeout: 60_000 });

  const files = new Map<string, string>();
  let current: string | null = null;
  const lines: string[] = [];
  const flush = () => {
    if (current) files.set(current, lines.join('\n'));
    lines.length = 0;
  };
  for (const line of stdout.split('\n')) {
    if (line.startsWith(FILE_MARK)) {
      flush();
      current = line.slice(FILE_MARK.length).trim();
      continue;
    }
    lines.push(line);
  }
  flush();
  return files;
}

/** What the panel stores for a site, or null when it is not something it can serve. */
export function serveOf(site: NginxSite): Serve | null {
  const tuning = {
    ...(site.maxBodyBytes !== undefined && { maxBodyBytes: site.maxBodyBytes }),
    ...(site.readTimeout !== undefined && { readTimeout: site.readTimeout }),
    ...(site.streaming !== undefined && { streaming: site.streaming }),
  };
  if (site.kind === 'proxy' && site.port) return { kind: 'proxy', port: site.port, ...tuning };
  if (site.kind === 'php' && site.root && site.socket) return { kind: 'php', root: site.root, socket: site.socket, ...tuning };
  if (site.kind === 'static' && site.root) return { kind: 'files', root: site.root, ...(site.spa && { spa: true }) };
  return null;
}

/** The Caddy route one site becomes. */
export function targetOf(serve: Serve): Target {
  if (serve.kind === 'proxy') {
    return {
      type: 'runtime',
      upstreamPort: serve.port,
      ...(serve.maxBodyBytes !== undefined && { maxBodyBytes: serve.maxBodyBytes }),
      ...(serve.readTimeout !== undefined && { readTimeout: serve.readTimeout }),
      ...(serve.streaming !== undefined && { streaming: serve.streaming }),
    };
  }
  if (serve.kind === 'php') {
    return {
      type: 'php',
      root: serve.root,
      socket: serve.socket,
      ...(serve.maxBodyBytes !== undefined && { maxBodyBytes: serve.maxBodyBytes }),
    };
  }
  if (serve.kind === 'files') return { type: 'split', parts: [{ path: null, root: serve.root, spa: serve.spa }] };
  return { type: 'placeholder' };
}

/**
 * Does this hostname resolve to this node? Caddy asks Let's Encrypt for a
 * certificate per hostname on the route, and one pointing somewhere else fails
 * the challenge — noisily, and forever. nginx never noticed because certbot
 * was told which names to ask for; Caddy asks for all of them.
 */
async function resolvesHere(host: string, publicIp: string): Promise<boolean> {
  const addresses = await dns.resolve4(host).catch(() => [] as string[]);
  const v6 = await dns.resolve6(host).catch(() => [] as string[]);
  if (addresses.length === 0 && v6.length === 0) return false;
  return addresses.includes(publicIp) || v6.includes(publicIp);
}

/** Read the node's nginx configuration and say what migrating it would do. */
export async function planMigration(node: SshTarget & { publicIp: string }): Promise<MigrationPlan> {
  const files = await readNginxFiles(node);
  const sites = [...files.values()].flatMap((text) => sitesOf(text));

  const plans: SitePlan[] = await Promise.all(
    sites.map(async (site) => {
      const serve = serveOf(site);
      const dangling: string[] = [];
      for (const host of site.hosts) if (!(await resolvesHere(host, node.publicIp))) dangling.push(host);
      return {
        site,
        serve,
        danglingHosts: dangling,
        blocked: serve ? null : site.warnings[0] ?? 'this site is not something the panel can serve',
      };
    }),
  );

  return {
    files: [...files.keys()],
    sites: plans,
    // a site the panel cannot serve would simply go dark after the switch
    ready: plans.length > 0 && plans.every((plan) => !plan.blocked),
  };
}

/** The whole Caddy configuration a plan becomes: one server block, one route per site. */
export function configFor(plan: MigrationPlan): any {
  const routes = plan.sites
    .filter((site): site is SitePlan & { serve: Serve } => !!site.serve)
    .map((site) => buildRoute(site.site.hosts, targetOf(site.serve)));
  return { apps: { http: { servers: { larika: { listen: [':80', ':443'], routes } } } } };
}

const systemctl = (node: SshTarget, ...args: string[]) =>
  execRoot(node, ['systemctl', ...args], { timeout: 60_000 });

/** Ask a host for its home page through the node's own loopback. */
async function answersLocally(node: SshTarget, host: string): Promise<boolean> {
  const { stdout } = await exec(
    node,
    ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10', '-H', `Host: ${host}`, 'http://127.0.0.1/'],
    { timeout: 30_000 },
  ).catch(() => ({ stdout: '000' }) as any);
  const code = Number(String(stdout).trim());
  // any answer at all is Caddy serving the name; 502 is the site's own upstream
  // being down, which is not something the switch caused
  return code > 0 && code !== 0;
}

export type MigrationResult = {
  switched: boolean;
  /** hosts that answered after the switch */
  verified: string[];
  /** hosts that did not, which is what triggers the rollback */
  failed: string[];
  rolledBack: boolean;
  message: string;
};

/**
 * Stop nginx, start Caddy with the whole plan loaded, and check every hostname
 * answers. Any that does not puts nginx back: its configuration was never
 * touched, so that is only a matter of starting it again.
 */
export async function migrateToCaddy(node: SshTarget & { publicIp: string }, plan: MigrationPlan): Promise<MigrationResult> {
  if (!plan.ready) {
    return { switched: false, verified: [], failed: [], rolledBack: false, message: 'The plan has sites that cannot be migrated — resolve those first.' };
  }

  const config = configFor(plan);
  const hosts = plan.sites.flatMap((site) => site.site.hosts);

  // Anything Caddy is already serving here is kept: this is an adoption, not a reset.
  const existing = await getCaddyConfig(node).catch(() => null);
  const existingRoutes = existing?.apps?.http?.servers?.larika?.routes;
  if (Array.isArray(existingRoutes) && existingRoutes.length > 0) {
    config.apps.http.servers.larika.routes = [...existingRoutes, ...config.apps.http.servers.larika.routes];
  }

  await systemctl(node, 'stop', 'nginx');
  try {
    await systemctl(node, 'enable', '--now', 'caddy-api');
    await loadCaddyConfig(node, config);
  } catch (error: any) {
    await systemctl(node, 'disable', '--now', 'caddy-api').catch(() => {});
    await systemctl(node, 'start', 'nginx').catch(() => {});
    return {
      switched: false,
      verified: [],
      failed: hosts,
      rolledBack: true,
      message: `Caddy would not take the configuration (${error?.message || error}) — nginx has been started again.`,
    };
  }

  const verified: string[] = [];
  const failed: string[] = [];
  for (const host of hosts) ((await answersLocally(node, host)) ? verified : failed).push(host);

  if (failed.length > 0) {
    await systemctl(node, 'disable', '--now', 'caddy-api').catch(() => {});
    await systemctl(node, 'start', 'nginx').catch(() => {});
    return {
      switched: false,
      verified,
      failed,
      rolledBack: true,
      message: `${failed.length} of ${hosts.length} hostnames did not answer through Caddy — nginx has been started again and is serving as before.`,
    };
  }

  // Only now is nginx kept from coming back on its own at the next reboot. Its
  // files stay where they are, so `systemctl enable --now nginx` is the way back.
  await systemctl(node, 'disable', 'nginx').catch(() => {});

  return {
    switched: true,
    verified,
    failed: [],
    rolledBack: false,
    message: `${verified.length} hostname${verified.length === 1 ? '' : 's'} now served by Caddy. nginx is stopped and disabled; its configuration is untouched.`,
  };
}
