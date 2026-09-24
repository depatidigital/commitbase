/**
 * Self-check for where a new route lands: npx tsx src/services/caddyService.check.ts
 */
import assert from 'assert';
import { buildRoute, ensureHttpServer, withHostBeside, withoutHosts, withRoute } from './caddyService';

const site = (host: string) => ({ match: [{ host: [host] }], handle: [], terminal: true });
const route = buildRoute('new.example.com', { type: 'runtime', upstreamPort: 3000 });
const hostOrder = (routes: any[]) => routes.map((r) => r.match?.[0]?.host?.[0] ?? '*');

// a catch-all proxy at the end (what a Caddyfile's fallback site becomes):
// the new host goes in front of it, or the catch-all answers for it
const catchAll = { handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: 'localhost:9200' }] }], terminal: true };
assert.deepStrictEqual(hostOrder(withRoute([site('a.com'), catchAll], route)), ['a.com', 'new.example.com', '*']);

// a catch-all without `terminal` still responds, so it still counts
const { terminal: _, ...openCatchAll } = catchAll;
assert.deepStrictEqual(hostOrder(withRoute([openCatchAll], route)), ['new.example.com', '*']);

// hostless middleware that does not respond (headers, encode) is not a catch-all
const middleware = { handle: [{ handler: 'headers' }] };
assert.deepStrictEqual(hostOrder(withRoute([middleware, site('a.com')], route)), ['*', 'a.com', 'new.example.com']);

// no catch-all: appended, as before
assert.deepStrictEqual(hostOrder(withRoute([site('a.com')], route)), ['a.com', 'new.example.com']);
assert.strictEqual(route.terminal, true);

// --- an app's names: one route for all of them; taking one off keeps the rest ---
const cms = { match: [{ host: ['a.go.id', 'b.go.id', 'c.go.id'] }], handle: [{ handler: 'file_server' }], terminal: true };
assert.deepStrictEqual(buildRoute(['a.go.id', 'b.go.id'], { type: 'runtime', upstreamPort: 3000 }).match, [{ host: ['a.go.id', 'b.go.id'] }]);
// one name off: the route stays, as written, with the others
const less = withoutHosts([cms, site('x.com')], ['B.go.id']);
assert.deepStrictEqual(less.map((r) => r.match[0].host), [['a.go.id', 'c.go.id'], ['x.com']]);
assert.deepStrictEqual(less[0].handle, cms.handle);
// its last name off: the route goes; a hostless catch-all is never touched
assert.deepStrictEqual(withoutHosts([site('x.com'), catchAll], ['x.com']), [catchAll]);
// a matcher left with no host would match every name: it goes, it does not widen
const split = { match: [{ host: ['x.com'], path: ['/api/*'] }, { host: ['y.com'] }], handle: [] };
assert.deepStrictEqual(withoutHosts([split], ['x.com'])[0].match, [{ host: ['y.com'] }]);
// one name on: beside an existing one, in that same route
assert.deepStrictEqual(withHostBeside([cms, site('x.com')], 'c.go.id', 'd.go.id').map((r) => r.match[0].host), [
  ['a.go.id', 'b.go.id', 'c.go.id', 'd.go.id'],
  ['x.com'],
]);

// a Caddyfile block on :80 only gets :443 (else HTTPS is refused); a node where
// another block already holds :443 is left alone — two servers on it fail the load
const listenOf = (servers: any) => Object.fromEntries(Object.entries<any>(ensureHttpServer({ apps: { http: { servers } } }).apps.http.servers).map(([k, v]) => [k, v.listen]));
assert.deepStrictEqual(listenOf({ srv0: { listen: [':80'], routes: [] } }), { srv0: [':80', ':443'] });
assert.deepStrictEqual(listenOf({ srv0: { listen: [':80'] }, srv1: { listen: [':443'] } }), { srv0: [':80'], srv1: [':443'] });
assert.deepStrictEqual(listenOf({}), { larika: [':80', ':443'] });

console.log('caddyService: withRoute + withoutHosts + withHostBeside + ensureHttpServer OK');
