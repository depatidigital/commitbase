import assert from 'node:assert/strict';
import { candidateParents } from '../lib/scope';

// Self-check for the hostname → parent-domain logic that guards tenant isolation.
// Run: npx tsx src/scripts/checkScope.ts

assert.deepEqual(candidateParents('api.staging.client.com'), [
  'api.staging.client.com',
  'staging.client.com',
  'client.com',
]);

assert.deepEqual(candidateParents('client.com'), ['client.com']);

// a bare label can never match a domain row
assert.deepEqual(candidateParents('localhost'), []);

// case and trailing dot are normalized
assert.deepEqual(candidateParents('APP.Client.COM.'), ['app.client.com', 'client.com']);

// the classic bypass: a lookalike suffix must not match the victim's domain
assert.ok(!candidateParents('evil-client.com').includes('client.com'));
assert.ok(!candidateParents('clientXcom').includes('client.com'));

console.log('✅ scope self-check passed');
