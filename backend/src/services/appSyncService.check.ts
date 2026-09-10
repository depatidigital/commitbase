/**
 * Self-check for the Caddyfile parser: npx ts-node src/services/appSyncService.check.ts
 */
import assert from 'assert';
import { parseCaddyfile, classifyRoute, routeHosts, isNotAnApp } from './appSyncService';

const sample = `
# a comment
app.example.com {
    reverse_proxy localhost:3005
    encode gzip
}

shop.example.com, www.shop.example.com {
    root * /var/www/html/shop/public
    php_fastcgi unix//run/php/php8.2-fpm.sock
    file_server
}

static.example.com {
    root * /var/www/html/static
    file_server
    handle_errors {
        rewrite * /404.html
        file_server
    }
}
`;

const sites = parseCaddyfile(sample, '/etc/caddy/sites/example.caddy');

assert.strictEqual(sites.length, 3, 'three site blocks');

assert.deepStrictEqual(sites[0]?.domains, ['app.example.com']);
assert.strictEqual(sites[0]?.port, 3005);
assert.strictEqual(sites[0]?.php, false);

assert.deepStrictEqual(sites[1]?.domains, ['shop.example.com', 'www.shop.example.com']);
assert.strictEqual(sites[1]?.php, true);
assert.strictEqual(sites[1]?.rootPath, '/var/www/html/shop/public');
// the FPM socket is only written down in the site file, so adoption needs it
assert.strictEqual(sites[1]?.socket, '/run/php/php8.2-fpm.sock');
assert.strictEqual(sites[0]?.socket, undefined);

// the nested handle_errors block must not close the site early
assert.strictEqual(sites[2]?.domains[0], 'static.example.com');
assert.strictEqual(sites[2]?.php, false);
assert.strictEqual(sites[2]?.port, undefined);

// --- live Caddy routes, which is where the inventory comes from now ---

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

// a redirect is a route, not an application
assert.strictEqual(classifyRoute(redirectRoute), null);

assert.deepStrictEqual(routeHosts(phpRoute), ['shop.example.com']);

// the wildcard is how apps under a domain resolve — importing it as an app would
// create a row for a hostname nobody can visit
assert.strictEqual(isNotAnApp('*.example.com'), true);
assert.strictEqual(isNotAnApp('app.example.com'), false);

console.log('appSyncService: parseCaddyfile + classifyRoute OK');
