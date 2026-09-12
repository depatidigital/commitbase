/**
 * Self-check for where a new route lands: npx tsx src/services/caddyService.check.ts
 */
import assert from 'assert';
import { buildRoute, withRoute } from './caddyService';

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

console.log('caddyService: withRoute OK');
