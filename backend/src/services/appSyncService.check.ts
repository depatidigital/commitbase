/**
 * Self-check for the inventory's route and listener parsing: npx tsx src/services/appSyncService.check.ts
 */
import assert from 'assert';
import { classifyRoute, routeHosts, isNotAnApp, parseListeners, pm2OwnerOf } from './appSyncService';
import { parentDomainOf } from '../lib/scope';
import { buildRoute } from './caddyService';

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

console.log('appSyncService: classifyRoute + parseListeners + parentDomainOf OK');
