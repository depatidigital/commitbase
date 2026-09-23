import * as dns from 'dns/promises';
import { exec, execRoot, type SshTarget } from '../lib/runner';
import { sitesOf, type NginxSite } from '../lib/nginxConfig';
import { allRoutesOf, buildRoute, getCaddyConfig, loadCaddyConfig, type Target } from './caddyService';
import { findCloudflareZone, listCloudflareDnsRecords } from './cloudflareService';
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
  /**
   * hostnames behind Cloudflare's proxy whose origin could not be read (a zone
   * in another account) — it may well not be this node's traffic at all
   */
  proxiedHosts?: string[];
  /** why it cannot be migrated, when it cannot */
  blocked: string | null;
  /** the Caddy route it becomes, exactly as it will be loaded — for the preview */
  route?: any;
};

export type MigrationPlan = {
  /** the nginx files that were read */
  files: string[];
  sites: SitePlan[];
  /** true when nothing blocks the switch */
  ready: boolean;
  /** caddy-api.service is on the node — Set up installs it, stopped, beside a running nginx */
  caddyInstalled: boolean;
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
    ...(site.deny?.length && { deny: site.deny }),
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
      ...(serve.deny?.length && { deny: serve.deny }),
    };
  }
  if (serve.kind === 'php') {
    return {
      type: 'php',
      root: serve.root,
      socket: serve.socket,
      ...(serve.maxBodyBytes !== undefined && { maxBodyBytes: serve.maxBodyBytes }),
      ...(serve.deny?.length && { deny: serve.deny }),
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
async function whereItResolves(host: string, publicIp: string): Promise<'here' | 'cloudflare' | 'elsewhere'> {
  const addresses = await dns.resolve4(host).catch(() => [] as string[]);
  const v6 = await dns.resolve6(host).catch(() => [] as string[]);
  if (addresses.includes(publicIp) || v6.includes(publicIp)) return 'here';
  // an orange-cloud record answers with Cloudflare's addresses, whatever its
  // origin is — the panel's own Cloudflare account can say what that origin is
  if (addresses.length > 0 && addresses.every(isCloudflareIp)) return (await cloudflareOrigin(host, publicIp)) ?? 'cloudflare';
  return 'elsewhere';
}

/** Where a proxied record really points, from the zone in the panel's Cloudflare account. null: not known. */
async function cloudflareOrigin(host: string, publicIp: string): Promise<'here' | 'elsewhere' | null> {
  const labels = host.split('.');
  // the zone is the host itself or one of its parents: sub.example.co.id → example.co.id
  for (let i = 0; i < labels.length - 1; i++) {
    const zone = await findCloudflareZone(labels.slice(i).join('.')).catch(() => null);
    if (!zone) continue;
    const records = (await listCloudflareDnsRecords(zone.id).catch(() => null)) ?? [];
    const own = records.filter((r: any) => String(r?.name).toLowerCase() === host && (r?.type === 'A' || r?.type === 'AAAA'));
    if (own.length === 0) return null;
    return own.some((r: any) => r.content === publicIp) ? 'here' : 'elsewhere';
  }
  return null;
}

// ponytail: Cloudflare's published IPv4 ranges (cloudflare.com/ips-v4), hardcoded — they change
// about once in years; fetch that list instead if one ever goes missing here
const CLOUDFLARE_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
const ipv4 = (ip: string) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);

/** Is this IPv4 address one of Cloudflare's? Pure. */
export function isCloudflareIp(ip: string): boolean {
  return CLOUDFLARE_V4.some((cidr) => {
    const [base, bits] = cidr.split('/');
    const size = 2 ** (32 - Number(bits));
    return Math.floor(ipv4(ip) / size) === Math.floor(ipv4(base!) / size);
  });
}

/** Read the node's nginx configuration and say what migrating it would do. */
export async function planMigration(node: SshTarget & { publicIp: string }): Promise<MigrationPlan> {
  const [files, caddyInstalled] = await Promise.all([
    readNginxFiles(node),
    exec(node, ['systemctl', 'cat', 'caddy-api'], { timeout: 20_000 }).then(() => true, () => false),
  ]);
  const sites = [...files.values()].flatMap((text) => sitesOf(text));

  const plans: SitePlan[] = await Promise.all(
    sites.map(async (site) => {
      const serve = serveOf(site);
      const dangling: string[] = [];
      const proxied: string[] = [];
      for (const host of site.hosts) {
        const where = await whereItResolves(host, node.publicIp);
        if (where === 'elsewhere') dangling.push(host);
        if (where === 'cloudflare') proxied.push(host);
      }
      // static files have no place to carry a deny: better not switched than exposed
      const exposes = serve?.kind === 'files' && site.deny?.length ? 'nginx denies some paths here, and a static site cannot carry that over' : null;
      return {
        site,
        serve,
        danglingHosts: dangling,
        proxiedHosts: proxied,
        blocked: exposes ?? (serve ? null : site.warnings[0] ?? 'this site is not something the panel can serve'),
        ...(serve && { route: buildRoute(site.hosts, targetOf(serve)) }),
      };
    }),
  );

  return {
    files: [...files.keys()],
    sites: plans,
    // a site the panel cannot serve would simply go dark after the switch
    ready: caddyInstalled && plans.length > 0 && plans.every((plan) => !plan.blocked),
    caddyInstalled,
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

/** How long certificates get to arrive after the switch before it is undone. */
const VERIFY_DEADLINE_MS = 120_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request to a host's home page through this node's own web server — HTTPS
 * on 127.0.0.1:443 under the host's real name, so the certificate is the one
 * visitors get. `insecure` skips checking it. 0 when nothing answered.
 */
export async function localCode(node: SshTarget, host: string, opts: { insecure?: boolean; http?: boolean } = {}): Promise<number> {
  const target = opts.http
    ? ['-H', `Host: ${host}`, 'http://127.0.0.1/']
    : ['--resolve', `${host}:443:127.0.0.1`, ...(opts.insecure ? ['-k'] : []), `https://${host}/`];
  const { stdout } = await exec(node, ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10', ...target], {
    timeout: 30_000,
  }).catch(() => ({ stdout: '000' }) as any);
  return Number(String(stdout).trim()) || 0;
}

/** What nginx answers for a host right now: the bar Caddy has to meet. */
async function baselineCode(node: SshTarget, host: string): Promise<number> {
  return (await localCode(node, host, { insecure: true })) || localCode(node, host, { http: true });
}

/**
 * Does Caddy serve this host at least as well as nginx did? It has to answer
 * over HTTPS with a certificate that checks out, and not fail where nginx did
 * not: a 502 from Caddy over nginx's 200 is an upstream it cannot reach (an FPM
 * socket it may not open, say), which is exactly the breakage to undo.
 * null when it does, else why not.
 */
export async function verifyHost(node: SshTarget, host: string, before: number, deadline: number): Promise<string | null> {
  let code = 0;
  // the first answers wait on the certificate: TLS has nothing to offer until it is issued
  while (!(code = await localCode(node, host, { insecure: true }))) {
    if (Date.now() > deadline) return `${host}: Caddy did not answer over HTTPS`;
    await sleep(3000);
  }
  if (code >= 500 && before > 0 && before < 500) return `${host}: Caddy answers ${code} where nginx answered ${before}`;
  while (!(await localCode(node, host))) {
    if (Date.now() > deadline) return `${host}: no valid certificate`;
    await sleep(3000);
  }
  return null;
}

export type MigrationResult = {
  switched: boolean;
  /** hosts that answered after the switch */
  verified: string[];
  /** why Caddy did not install the switch, which is what triggers the rollback */
  failed: string[];
  /** hosts Caddy serves that did not pass the HTTPS check: said, never rolled back for */
  warnings?: string[];
  /** hosts not checked: their DNS points elsewhere, or nginx was not serving them either */
  unchecked: string[];
  rolledBack: boolean;
  message: string;
};

/**
 * Stop nginx, start Caddy with the whole plan loaded, and check every hostname
 * answers. Any that does not puts nginx back: its configuration was never
 * touched, so that is only a matter of starting it again.
 */
export async function migrateToCaddy(node: SshTarget & { publicIp: string }, plan: MigrationPlan): Promise<MigrationResult> {
  if (!plan.caddyInstalled) {
    return { switched: false, verified: [], failed: [], unchecked: [], rolledBack: false, message: 'Caddy is not installed on this node — run Set up first (nginx keeps serving while it installs).' };
  }
  if (!plan.ready) {
    return { switched: false, verified: [], failed: [], unchecked: [], rolledBack: false, message: 'The plan has sites that cannot be migrated — resolve those first.' };
  }

  const config = configFor(plan);
  const hosts = plan.sites.flatMap((site) => site.site.hosts);
  const dangling = new Set(plan.sites.flatMap((site) => site.danglingHosts));

  // measured before anything changes: what each host answers under nginx
  const before = new Map(
    await Promise.all(hosts.filter((host) => !dangling.has(host)).map(async (host) => [host, await baselineCode(node, host)] as const)),
  );
  // a certificate for a name pointing elsewhere can never be issued, and a host
  // nginx does not answer for sets no bar — neither can tell a good switch from a bad one
  const checked = [...before].filter(([, code]) => code > 0).map(([host]) => host);
  const unchecked = hosts.filter((host) => !checked.includes(host));

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
      unchecked: [],
      rolledBack: true,
      message: `Caddy would not take the configuration (${error?.message || error}) — nginx has been started again.`,
    };
  }

  // Rolled back only when Caddy did not install the switch: it is not running,
  // a planned hostname is missing from its live config, or it does not answer
  // for one on :80. That is the part the switch itself can get wrong.
  const live = await getCaddyConfig(node).catch(() => null);
  const liveHosts = new Set(allRoutesOf(live).flatMap((route: any) => (Array.isArray(route?.match) ? route.match : []).flatMap((m: any) => m?.host ?? [])));
  const missing = hosts.filter((host) => !liveHosts.has(host));
  const silent = live && missing.length === 0 ? (await Promise.all(hosts.map(async (host) => ((await localCode(node, host, { http: true })) ? null : host)))).filter((host): host is string => !!host) : [];
  const failed = [
    ...(live ? [] : ['Caddy is not running after the switch']),
    ...missing.map((host) => `${host}: not in Caddy's live config`),
    ...silent.map((host) => `${host}: Caddy does not answer for it on :80`),
  ];

  if (failed.length > 0) {
    await systemctl(node, 'disable', '--now', 'caddy-api').catch(() => {});
    await systemctl(node, 'start', 'nginx').catch(() => {});
    return {
      switched: false,
      verified: [],
      failed,
      unchecked,
      rolledBack: true,
      message: `Caddy did not install the switch correctly (${failed.join('; ')}) — nginx has been started again and is serving as before.`,
    };
  }

  // Only now is nginx kept from coming back on its own at the next reboot. Its
  // files stay where they are, so `systemctl enable --now nginx` is the way back.
  await systemctl(node, 'disable', 'nginx').catch(() => {});

  // How each site now answers over HTTPS is reported, never rolled back for: a
  // certificate still being issued (or one ACME cannot get through Cloudflare)
  // is something to fix on the name, not a reason to take every site back.
  const deadline = Date.now() + VERIFY_DEADLINE_MS;
  const outcomes = await Promise.all(checked.map(async (host) => [host, await verifyHost(node, host, before.get(host)!, deadline)] as const));
  const verified = outcomes.filter(([, why]) => !why).map(([host]) => host);
  const warnings = outcomes.flatMap(([, why]) => (why ? [why] : []));

  return {
    switched: true,
    verified,
    failed: [],
    unchecked,
    warnings,
    rolledBack: false,
    message:
      `Caddy serves all ${hosts.length} hostnames; nginx is stopped and disabled, its configuration untouched. ` +
      `${verified.length} answer over HTTPS with a valid certificate.` +
      (warnings.length ? ` Needs attention: ${warnings.join('; ')}.` : '') +
      (unchecked.length ? ` Not checked over HTTPS (DNS elsewhere, or not served before): ${unchecked.join(', ')}.` : ''),
  };
}
