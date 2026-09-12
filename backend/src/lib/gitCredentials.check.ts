/**
 * Self-check for the git credential plumbing: npx tsx src/lib/gitCredentials.check.ts
 *
 * The point of this file is the leak guard: the token must never appear in the
 * command line, only in the environment.
 */
import assert from 'assert';
import { USERNAME, credentialArgs, needsRefresh } from './gitCredentials';

// Each provider wants its own fixed username alongside an OAuth token.
assert.strictEqual(USERNAME.github, 'x-access-token');
assert.strictEqual(USERNAME.gitlab, 'oauth2');

// The helper references the environment variable; it does not interpolate a secret.
const args = credentialArgs('oauth2').join(' ');
assert.ok(args.includes('$CB_GIT_TOKEN'), 'helper must read the token from the environment');
assert.ok(!args.includes('glpat-'), 'no token may appear in the arguments');

const now = Date.parse('2026-01-01T00:00:00Z');
const at = (minutes: number) => new Date(now + minutes * 60_000);

// GitHub: no expiry, no refresh token — never refreshed.
assert.strictEqual(needsRefresh(null, null, now), false);
// An expiry with no refresh token cannot be refreshed either.
assert.strictEqual(needsRefresh(at(-10), null, now), false);
// Comfortably valid.
assert.strictEqual(needsRefresh(at(60), 'r', now), false);
// Inside the 2-minute skew: refresh before a slow deploy outlives it.
assert.strictEqual(needsRefresh(at(1), 'r', now), true);
// Already expired.
assert.strictEqual(needsRefresh(at(-1), 'r', now), true);

console.log('gitCredentials: OK');
