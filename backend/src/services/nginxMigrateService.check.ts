/**
 * Self-check for what an adopted nginx site becomes in Caddy:
 * npx tsx src/services/nginxMigrateService.check.ts
 */
import assert from 'assert';
import { sitesOf } from '../lib/nginxConfig';
import { buildRoute } from './caddyService';
import { configFor, isCloudflareIp, serveOf, targetOf, type MigrationPlan } from './nginxMigrateService';
import { readTuning } from './hostRouteService';

const site = (text: string) => sitesOf(text)[0]!;

// a proxy site keeps the two things that change how it behaves: without them
// the booting page 504s at 60s and arrives in one lump instead of streaming
const proxy = site(`server {
  server_name jdih.example.go.id;
  location / { proxy_pass http://127.0.0.1:8082; proxy_read_timeout 300s; proxy_buffering off; }
  listen 443 ssl;
}`);
const proxyServe = serveOf(proxy)!;
assert.deepStrictEqual(proxyServe, { kind: 'proxy', port: 8082, readTimeout: '300s', streaming: true });

const proxyRoute = buildRoute(['jdih.example.go.id'], targetOf(proxyServe));
const reverse = proxyRoute.handle.find((h: any) => h.handler === 'reverse_proxy');
assert.strictEqual(reverse.upstreams[0].dial, 'localhost:8082');
assert.strictEqual(reverse.transport.read_timeout, '300s');
assert.strictEqual(reverse.flush_interval, -1);

// PHP keeps its upload limit — roundcube's 50M attachments are the whole point
const php = site(`server {
  server_name webmail.example.go.id webmail.other.id;
  root /usr/share/roundcube;
  client_max_body_size 50M;
  location / { try_files $uri $uri/ /index.php?$query_string; }
  location ~ \\.php$ { fastcgi_pass unix:/run/php/php8.3-fpm.sock; }
}`);
const phpServe = serveOf(php)!;
assert.deepStrictEqual(phpServe, {
  kind: 'php',
  root: '/usr/share/roundcube',
  socket: '/run/php/php8.3-fpm.sock',
  maxBodyBytes: 52428800,
});
const phpRoute = buildRoute(php.hosts, targetOf(phpServe));
assert.deepStrictEqual(phpRoute.handle[0], { handler: 'request_body', max_size: 52428800 });
// one block, four names, one route
assert.deepStrictEqual(phpRoute.match[0].host, php.hosts);

// static files, with and without the single-page fallback
assert.deepStrictEqual(serveOf(site('server { server_name s.example; root /var/www/s; location / { try_files $uri /index.html; } }')), {
  kind: 'files',
  root: '/var/www/s',
  spa: true,
});

// a site the panel cannot serve has no serve, which is what blocks the switch
assert.strictEqual(serveOf(site('server { server_name r.example; location / { proxy_pass http://10.0.0.5:3000; } }')), null);

// the whole configuration is one server block on :80 and :443, one route per site
const plan: MigrationPlan = {
  files: ['/etc/nginx/sites-enabled/a'],
  sites: [
    { site: proxy, serve: proxyServe, danglingHosts: [], blocked: null },
    { site: php, serve: phpServe, danglingHosts: [], blocked: null },
  ],
  ready: true,
  caddyInstalled: true,
};
const config = configFor(plan);
assert.deepStrictEqual(config.apps.http.servers.larika.listen, [':80', ':443']);
assert.strictEqual(config.apps.http.servers.larika.routes.length, 2);
// every hostname of every site is in the config, so Caddy asks for all their certs
const hosts = config.apps.http.servers.larika.routes.flatMap((r: any) => r.match[0].host);
assert.strictEqual(hosts.length, 3);
assert.ok(hosts.includes('webmail.other.id'));

// a site that cannot be served is never silently dropped from the switch
const blocked: MigrationPlan = { ...plan, sites: [...plan.sites, { site: proxy, serve: null, danglingHosts: [], blocked: 'nope' }], ready: false };
assert.strictEqual(configFor(blocked).apps.http.servers.larika.routes.length, 2);

// roundcube's deny rules come along: dropping them would serve config/ and logs/
const guarded = site(`server {
  server_name webmail.example.go.id;
  root /usr/share/roundcube;
  location / { try_files $uri $uri/ /index.php; }
  location ~ ^/(config|temp|logs)/ { deny all; }
  location = /composer.json { deny all; }
  location /admin { allow 10.0.0.0/8; deny all; }
  location /static { alias /srv/static; }
  location ~ \\.php$ { fastcgi_pass unix:/run/php/php8.3-fpm.sock; }
}`);
assert.deepStrictEqual(guarded.deny, ['^/(config|temp|logs)/', '^/composer\\.json$', '^/admin']);
assert.ok(guarded.warnings.some((w) => w.includes('allow rules are not carried over')));
assert.ok(guarded.warnings.some((w) => w.includes('location /static is not carried over')));
const guardedRoute = buildRoute(guarded.hosts, targetOf(serveOf(guarded)!));
// the 403 runs first, before PHP ever sees the request
assert.strictEqual(guardedRoute.handle[0].routes[0].handle[0].status_code, 403);
assert.deepStrictEqual(guardedRoute.handle[0].routes[0].match[0], { path_regexp: { pattern: '^/(config|temp|logs)/' } });
// and survives being stored and read back as a serve
assert.deepStrictEqual(readTuning(serveOf(guarded)).deny, guarded.deny);

// an orange-cloud record is not a name pointing elsewhere
assert.ok(isCloudflareIp('104.21.3.4'));
assert.ok(isCloudflareIp('172.67.1.1'));
assert.ok(!isCloudflareIp('103.55.38.63'));

console.log('nginxMigrateService: ok');
