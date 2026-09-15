/**
 * Self-check for composing a hostname's route from its apps: npx tsx src/services/hostRouteService.check.ts
 */
import assert from 'assert';
import { byPrecedence, composeHostHandle, normalizeBindingPath, pathPrefix, readServe, serveHandle, type Binding } from './hostRouteService';
import { buildRoute } from './caddyService';
import { routeParts } from './appSyncService';

// the longest prefix first, the whole name last
assert.deepStrictEqual(
  [{ path: '' }, { path: '/api/*' }, { path: '/api/v2/*' }, { path: '/ws*' }].sort(byPrecedence).map((b) => b.path),
  ['/api/v2/*', '/api/*', '/ws*', ''],
);
assert.strictEqual(pathPrefix('/api/*'), '/api');
assert.strictEqual(pathPrefix('/ws*'), '/ws');

// one app on the whole name: exactly the route a single-app hostname has always had
assert.deepStrictEqual(composeHostHandle([{ path: '', stripPrefix: false, serve: { kind: 'proxy', port: 3000 } }]), buildRoute('x', { type: 'runtime', upstreamPort: 3000 }).handle);
assert.deepStrictEqual(
  serveHandle({ kind: 'php', root: '/var/www/site/public', socket: '/run/php/fpm.sock' }),
  buildRoute('x', { type: 'php', root: '/var/www/site/public', socket: '/run/php/fpm.sock' }).handle,
);

// arusflow as two apps: /api/* to the server's port, the rest the web's files (SPA) — in any order given
const arusflow: Binding[] = [
  { path: '', stripPrefix: false, serve: { kind: 'files', root: '/var/www/html/arusflow_9200/web/dist', spa: true } },
  { path: '/api/*', stripPrefix: false, serve: { kind: 'proxy', port: 9200 } },
];
const handle = composeHostHandle(arusflow);
// the sync reads it back as the same split — nothing changes on the next sync
assert.deepStrictEqual(routeParts({ match: [{ host: ['app.arusflow.id'] }], handle }), [
  // a proxy dials localhost, as every panel route always has
  { path: '/api/*', proxy: 'localhost:9200' },
  { path: null, root: '/var/www/html/arusflow_9200/web/dist', spa: true },
]);
// kept prefix: no rewrite; the API gets /api/... as asked
assert.strictEqual(JSON.stringify(handle).includes('strip_path_prefix'), false);

// a stripped prefix is rewritten away before the app is reached
const stripped = composeHostHandle([
  { path: '/docs/*', stripPrefix: true, serve: { kind: 'files', root: '/srv/docs' } },
  { path: '', stripPrefix: false, serve: { kind: 'proxy', port: 3000 } },
]);
assert.deepStrictEqual(stripped[0].routes[0].handle[0], { handler: 'rewrite', strip_path_prefix: '/docs' });
assert.deepStrictEqual(stripped[0].routes[0].match, [{ path: ['/docs/*'] }]);
assert.strictEqual(stripped[0].routes[1].match, undefined);

// what is stored is checked before it becomes a route
assert.deepStrictEqual(readServe({ kind: 'proxy', port: 9200 }), { kind: 'proxy', port: 9200 });
assert.strictEqual(readServe({ kind: 'proxy', port: 'x' }), null);
assert.strictEqual(readServe({ kind: 'files', root: 'relative' }), null);
assert.strictEqual(readServe(null), null);
// never deployed: the placeholder page, not a redirect to an empty bucket prefix
assert.deepStrictEqual(readServe({ kind: 'placeholder' }), { kind: 'placeholder' });
assert.strictEqual(serveHandle({ kind: 'placeholder' })[0].handler, 'static_response');
assert.strictEqual(serveHandle({ kind: 'redirect', url: 'https://x' })[0].headers.Location[0], 'https://x');

// a path as asked for: the whole name, or a prefix pattern
assert.strictEqual(normalizeBindingPath(''), '');
assert.strictEqual(normalizeBindingPath('/'), '');
assert.strictEqual(normalizeBindingPath(' /api/* '), '/api/*');
assert.strictEqual(normalizeBindingPath('/pos.apk'), '/pos.apk');
assert.strictEqual(normalizeBindingPath('api'), null);
assert.strictEqual(normalizeBindingPath('/a/../b'), null);
assert.strictEqual(normalizeBindingPath('/a b'), null);

console.log('hostRouteService: ok');
