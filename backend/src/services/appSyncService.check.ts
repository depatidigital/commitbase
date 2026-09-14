/**
 * Self-check for the inventory's route and listener parsing: npx tsx src/services/appSyncService.check.ts
 */
import assert from 'assert';
import { classifyRoute, routeHosts, routeParts, isNotAnApp, parseListeners, pm2OwnerOf, repositoryFromRemote, mergeSameSite, databaseRefs, pm2StartCommand, buildCommandFrom, bindingLabel, identityKeys, type DiscoveredApp } from './appSyncService';
import { parentDomainOf } from '../lib/scope';
import { buildRoute, caddyfileFor, routingProblem } from './caddyService';

// --- live Caddy routes: the inventory reads the admin API, never a Caddyfile ---

const runtimeRoute = {
  match: [{ host: ['app.example.com'] }],
  handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: 'localhost:20001' }] }],
};

const phpRoute = {
  match: [{ host: ['shop.example.com'] }],
  handle: [
    {
      handler: 'subroute',
      routes: [
        { handle: [{ handler: 'vars', root: '/home/acme/apps/shop/current/public' }] },
        {
          handle: [
            {
              handler: 'reverse_proxy',
              transport: { protocol: 'fastcgi', root: '/home/acme/apps/shop/current/public' },
              upstreams: [{ dial: 'unix//run/php/php8.3-fpm-acme.sock' }],
            },
          ],
        },
        { handle: [{ handler: 'file_server' }] },
      ],
    },
  ],
};

const filesRoute = {
  match: [{ host: ['static.example.com'] }],
  handle: [
    {
      handler: 'subroute',
      routes: [
        { handle: [{ handler: 'vars', root: '/var/www/html/static' }] },
        { handle: [{ handler: 'file_server' }] },
      ],
    },
  ],
};

const bucketRoute = {
  match: [{ host: ['site.example.com'] }],
  handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: 'pub-abc.r2.dev:443' }] }],
};

const redirectRoute = {
  match: [{ host: ['old.example.com'] }],
  handle: [{ handler: 'redirect', location: 'https://new.example.com', status_code: 308 }],
};

assert.deepStrictEqual(classifyRoute(runtimeRoute), { type: 'NODEJS', port: 20001 });

const php = classifyRoute(phpRoute);
assert.strictEqual(php?.type, 'PHP');
assert.strictEqual(php?.rootPath, '/home/acme/apps/shop/current/public');
// the socket has to survive the unix/ prefix, or the route cannot be rebuilt
assert.strictEqual(php?.socket, '/run/php/php8.3-fpm-acme.sock');

// a Caddyfile site: php_fastcgi's root is a placeholder, the real one is the site's `root`
const caddyfilePhp = JSON.parse(JSON.stringify(phpRoute));
caddyfilePhp.handle[0].routes[1].handle[0].transport.root = '{http.vars.root}';
caddyfilePhp.handle[0].routes[0].handle[0].root = '/var/www/news';
assert.strictEqual(classifyRoute(caddyfilePhp)?.rootPath, '/var/www/news');
// neither says: no folder, rather than a placeholder or a guess here
delete caddyfilePhp.handle[0].routes[0].handle[0].root;
assert.strictEqual(classifyRoute(caddyfilePhp)?.rootPath, undefined);

assert.deepStrictEqual(classifyRoute(filesRoute), {
  type: 'STATIC',
  rootPath: '/var/www/html/static',
});

assert.strictEqual(classifyRoute(bucketRoute)?.type, 'STATIC');
assert.strictEqual(classifyRoute(bucketRoute)?.origin, 'pub-abc.r2.dev');

// a site in the shared bucket: proxied to the bucket's custom domain, its
// folder prefixed after the index rewrites, and still read back as STATIC
const shared = buildRoute('larika.id', { type: 'bucket', origin: 'cdn.depatidigital.com/larika/larika.id' });
const sharedProxy = shared.handle.find((h: any) => h.handler === 'reverse_proxy');
assert.strictEqual(sharedProxy.upstreams[0].dial, 'cdn.depatidigital.com:443');
assert.deepStrictEqual(sharedProxy.headers.request.set.Host, ['cdn.depatidigital.com']);
const rewrites = shared.handle[0].routes.map((r: any) => r.handle[0]);
assert.deepStrictEqual(rewrites[rewrites.length - 1], { handler: 'rewrite', uri: '/larika/larika.id{http.request.uri}' });
assert.deepStrictEqual(classifyRoute(shared), { type: 'STATIC', origin: 'cdn.depatidigital.com' });
// a bucket of its own gets no folder rewrite
const own = buildRoute('a.com', { type: 'bucket', origin: 'pub-abc.r2.dev' });
assert.strictEqual(own.handle[0].routes.length, 2);

// a redirect is a route, not an application
assert.strictEqual(classifyRoute(redirectRoute), null);

assert.deepStrictEqual(routeHosts(phpRoute), ['shop.example.com']);

// the wildcard is how apps under a domain resolve — importing it as an app would
// create a row for a hostname nobody can visit
assert.strictEqual(isNotAnApp('*.example.com'), true);
assert.strictEqual(isNotAnApp('app.example.com'), false);

// --- path-split site: `/ws*` → socket server, catch-all → the app ---

const proxyTo = (port: number) => ({
  handler: 'subroute',
  routes: [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: `localhost:${port}` }] }] }],
});
assert.strictEqual(
  classifyRoute({
    match: [{ host: ['split.example.com'] }],
    handle: [
      {
        handler: 'subroute',
        routes: [
          { match: [{ path: ['/ws*'] }], handle: [proxyTo(5503)] },
          { handle: [proxyTo(5502)] },
        ],
      },
    ],
  })?.port,
  5502,
);

// --- ss -ltnp: the listener pid is how a proxied port finds its directory ---

const listeners = parseListeners(
  [
    'LISTEN 0 511 127.0.0.1:1600 0.0.0.0:* users:(("node",pid=4242,fd=20))',
    'LISTEN 0 511 [::1]:1600 [::]:* users:(("node",pid=4242,fd=21))',
    // not root: ss shows the socket but not its owner
    'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*',
  ].join('\n'),
);
assert.strictEqual(listeners.get(1600), 4242);
assert.strictEqual(listeners.has(22), true);
assert.strictEqual(listeners.get(22), undefined);

// pm2 spawned `pnpm start`; the listener is its great-grandchild (pnpm → sh → tsx → node)
const pm2ByPid = new Map([[237614, 'arusflow']]);
const parents = new Map([[237642, 237626], [237626, 237625], [237625, 237614], [237614, 211245], [211245, 1]]);
assert.strictEqual(pm2OwnerOf(237642, pm2ByPid, parents), 'arusflow');
assert.strictEqual(pm2OwnerOf(237614, pm2ByPid, parents), 'arusflow');
// not under any pm2 process (a Docker proxy, caddy itself)
assert.strictEqual(pm2OwnerOf(999, pm2ByPid, new Map([[999, 1]])), undefined);
// no ps output: exact matches only
assert.strictEqual(pm2OwnerOf(237642, pm2ByPid, new Map()), undefined);

// synced apps link to their Domain: longest suffix wins, root counts, lookalikes don't
const doms = [{ id: 'a', name: 'client.com' }, { id: 'b', name: 'staging.client.com' }, { id: 'c', name: 'larika.id' }];
assert.strictEqual(parentDomainOf('app.larika.id', doms)?.id, 'c');
assert.strictEqual(parentDomainOf('larika.id', doms)?.id, 'c');
assert.strictEqual(parentDomainOf('api.staging.client.com', doms)?.id, 'b');
assert.strictEqual(parentDomainOf('notclient.com', doms), null);
assert.strictEqual(parentDomainOf('web.pm2.local', doms), null);

// git remotes: stored as HTTPS, and a token in the URL never survives
assert.strictEqual(repositoryFromRemote('git@github.com:acme/shop.git'), 'https://github.com/acme/shop.git');
assert.strictEqual(repositoryFromRemote('https://github.com/acme/shop.git'), 'https://github.com/acme/shop.git');
assert.strictEqual(repositoryFromRemote('https://deploy:ghp_secret@github.com/acme/shop'), 'https://github.com/acme/shop');
assert.strictEqual(repositoryFromRemote('ssh://git@gitlab.example.com:2222/team/app.git'), 'https://gitlab.example.com/team/app.git');
assert.strictEqual(repositoryFromRemote('/srv/git/shop.git'), null);
assert.strictEqual(repositoryFromRemote(''), null);

// --- a hostname split by path: /api/* to the app, the rest a static front end
// (app.arusflow.id, as the Caddyfile adapter writes it) ---
const splitRoute = {"match":[{"host":["app.arusflow.id"]}],"handle":[{"routes":[{"group":"group81","match":[{"path":["/api/*"]}],"handle":[{"routes":[{"handle":[{"handler":"reverse_proxy","upstreams":[{"dial":"localhost:9200"}]}]}],"handler":"subroute"}]},{"group":"group81","handle":[{"routes":[{"handle":[{"root":"/var/www/html/arusflow_9200/web/dist","handler":"vars"}]},{"match":[{"file":{"try_files":["{http.request.uri.path}","/index.html"]}}],"handle":[{"uri":"{http.matchers.file.relative}","handler":"rewrite"}]},{"handle":[{"hide":["/etc/caddy/sites/arusflow.id.caddy"],"handler":"file_server"}]}],"handler":"subroute"}]}],"handler":"subroute"}],"terminal":true};
assert.deepStrictEqual(routeParts(splitRoute), [
  { path: '/api/*', proxy: 'localhost:9200' },
  // try_files {path} /index.html: the front end's router answers unknown paths
  { path: null, root: '/var/www/html/arusflow_9200/web/dist', spa: true },
]);
// the hostname is still the app behind the proxy
assert.deepStrictEqual(classifyRoute(splitRoute), { type: 'NODEJS', port: 9200 });
// one thing serving it all is not a split; nor is PHP (file_server + FastCGI are one app)
assert.strictEqual(routeParts(runtimeRoute), null);
assert.strictEqual(routeParts(phpRoute), null);

// --- one folder behind several hostnames is one app with all of them ---
const site = (domain: string, extra: Partial<DiscoveredApp> = {}): DiscoveredApp =>
  ({ name: domain, bindings: [{ host: domain, path: '' }], runtime: 'CADDY_PHP', type: 'PHP', status: 'RUNNING', rootPath: '/var/www/cms/public', ...extra });
const merged = mergeSameSite([
  site('a.go.id'),
  site('b.go.id'),
  site('other.go.id', { rootPath: '/var/www/other' }),
  site('c.go.id'),
  // same folder, served differently (a proxied port): not the same app
  site('api.go.id', { runtime: 'CADDY_PROXY', port: 9000 }),
  // nothing known about where it runs: never merged
  site('x.go.id', { rootPath: undefined }),
  site('y.go.id', { rootPath: undefined }),
  site('worker.pm2.local', { runtime: 'PM2', port: 9000 }),
]);
assert.deepStrictEqual(merged.map((app) => app.bindings.map(bindingLabel)), [
  ['a.go.id', 'b.go.id', 'c.go.id'],
  ['other.go.id'],
  ['api.go.id'],
  ['x.go.id'],
  ['y.go.id'],
  ['worker.pm2.local'],
]);

// --- apps by what serves them: the same port on two names/paths is one app; a folder is another ---
{
  const part = (host: string, at: string, extra: Partial<DiscoveredApp>): DiscoveredApp =>
    ({ name: `${host}${at}`, bindings: [{ host, path: at }], status: 'RUNNING', ...extra }) as DiscoveredApp;
  const apps = mergeSameSite([
    part('app.arusflow.id', '/api/*', { runtime: 'PM2', type: 'NODEJS', port: 9200, processName: 'arusflow', serve: { kind: 'proxy', port: 9200 } }),
    part('app.arusflow.id', '', { runtime: 'CADDY_STATIC', type: 'STATIC', rootPath: '/w/web/dist', serve: { kind: 'files', root: '/w/web/dist', spa: true } }),
    part('arusflow.id', '/api/*', { runtime: 'PM2', type: 'NODEJS', port: 9200, processName: 'arusflow', serve: { kind: 'proxy', port: 9200 } }),
  ]);
  assert.deepStrictEqual(apps.map((app) => app.bindings.map(bindingLabel)), [['app.arusflow.id/api/*', 'arusflow.id/api/*'], ['app.arusflow.id']]);
  // the row that runs the process keeps being the process's app, whatever names it held
  assert.deepStrictEqual(identityKeys({ processName: 'arusflow', runtime: 'PM2', rootPath: '/w/server' }), ['pm2 arusflow', 'dir PM2 /w/server']);
  assert.ok(identityKeys(apps[0]!).includes('pm2 arusflow'));
  assert.ok(identityKeys(apps[1]!).includes('serve files /w/web/dist'));
}

// --- routing set in the panel reads back the same on the next sync ---
{
  const parts = [
    { path: '/api/*, /ws*', port: 9200 },
    { path: null, root: '/var/www/html/arusflow/web/dist', spa: true },
  ];
  const route = buildRoute(['app.arusflow.id', 'www.arusflow.id'], { type: 'split', parts });
  assert.deepStrictEqual(route.match, [{ host: ['app.arusflow.id', 'www.arusflow.id'] }]);
  assert.deepStrictEqual(routeParts(route), [
    { path: '/api/*, /ws*', proxy: '127.0.0.1:9200' },
    { path: null, root: '/var/www/html/arusflow/web/dist', spa: true },
  ]);
  assert.strictEqual(
    caddyfileFor(['app.arusflow.id'], parts),
    'app.arusflow.id {\n\thandle /api/* /ws* {\n\t\treverse_proxy 127.0.0.1:9200\n\t}\n\thandle {\n\t\troot * /var/www/html/arusflow/web/dist\n\t\ttry_files {path} /index.html\n\t\tfile_server\n\t}\n}',
  );
  // a tenant: its own ports and folder only
  const limits = { ports: new Set([9200]), base: '/var/www/html/arusflow' };
  assert.ok(Array.isArray(routingProblem(parts, limits)));
  assert.match(String(routingProblem([{ path: null, port: 5432 }], limits)), /not one this app runs on/);
  assert.match(String(routingProblem([{ path: null, root: '/var/www/html/other' }], limits)), /outside this app's folder/);
  assert.match(String(routingProblem([{ path: null, root: '/var/www/html/arusflow/../other' }], limits)), /not an absolute folder/);
  // the catch-all: exactly one, last
  assert.match(String(routingProblem([{ path: null, port: 9200 }, { path: '/api/*', port: 9200 }], limits)), /comes last/);
  assert.match(String(routingProblem([{ path: 'api', port: 9200 }], limits)), /not a path|comes last/);
  // a platform admin: anywhere
  assert.ok(Array.isArray(routingProblem([{ path: null, port: 5432 }], { ports: null, base: null })));
}

// --- what pm2 runs, as one would type it in the app's folder ---
assert.strictEqual(pm2StartCommand({ pm_exec_path: '/usr/bin/npm', args: ['run', 'start'], exec_interpreter: 'none' }), 'npm run start');
assert.strictEqual(pm2StartCommand({ pm_exec_path: '/usr/lib/node_modules/pnpm/bin/pnpm.cjs', args: 'start', exec_interpreter: 'node' }), 'pnpm start');
assert.strictEqual(
  pm2StartCommand({ pm_exec_path: '/var/www/html/cpns/dist/server.js', pm_cwd: '/var/www/html/cpns', args: ['--port', '2100'], exec_interpreter: 'node' }),
  'node dist/server.js --port 2100',
);
assert.strictEqual(
  pm2StartCommand({ pm_exec_path: '/home/u/.nvm/versions/node/v24/bin/npx', args: ['next', 'start', '-p', '2100'], exec_interpreter: 'node' }),
  'npx next start -p 2100',
);
assert.strictEqual(pm2StartCommand({}), undefined);

// --- how a Node app is built: its build script, by its lockfile's package manager ---
assert.strictEqual(buildCommandFrom('{"scripts":{"build":"next build"}}', ['package.json', 'pnpm-lock.yaml']), 'pnpm run build');
assert.strictEqual(buildCommandFrom('{"scripts":{"build":"vite build"}}', ['yarn.lock']), 'yarn build');
assert.strictEqual(buildCommandFrom('{"scripts":{"build":"tsc"}}', ['package-lock.json']), 'npm run build');
assert.strictEqual(buildCommandFrom('{"scripts":{"start":"node x"}}', []), undefined);
assert.strictEqual(buildCommandFrom('not json', []), undefined);

// --- which databases an app's .env names: names, engine, host — never a password ---
assert.deepStrictEqual(databaseRefs({ DATABASE_URL: 'postgresql://app:s3cr%40t@127.0.0.1:5432/shop_db?schema=public' }), [
  { name: 'shop_db', engine: 'POSTGRESQL', host: '127.0.0.1' },
]);
// Laravel
assert.deepStrictEqual(databaseRefs({ DB_CONNECTION: 'mysql', DB_HOST: 'localhost', DB_DATABASE: 'cpns', DB_PASSWORD: 'x' }), [
  { name: 'cpns', engine: 'MYSQL', host: 'localhost' },
]);
assert.deepStrictEqual(databaseRefs({ DB_CONNECTION: 'pgsql', DB_DATABASE: 'blog' }), [{ name: 'blog', engine: 'POSTGRESQL', host: undefined }]);
// nothing that names a database: nothing
assert.deepStrictEqual(databaseRefs({ APP_KEY: 'base64:x', DATABASE_URL: 'not a url' }), []);

console.log('appSyncService: classifyRoute + parseListeners + parentDomainOf + repositoryFromRemote OK');
