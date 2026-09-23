/**
 * Self-check for reading Caddy's log before switching a proxy off:
 * npx tsx src/services/sslProvisionService.check.ts
 */
import assert from 'assert';
import { lastAcmeError, rateLimitOf } from './sslProvisionService';

const journal = [
  '{"level":"error","logger":"tls.obtain","msg":"could not get certificate from issuer","identifier":"jdih.example.go.id","error":"HTTP 403 urn:ietf:params:acme:error:unauthorized - Invalid response"}',
  '{"level":"error","logger":"tls.obtain","identifier":"jdih.example.go.id","error":"HTTP 429 urn:ietf:params:acme:error:rateLimited - too many failed authorizations recently: see https://letsencrypt.org/docs/failed-validation-limit/; retry after 2026-09-23 11:40:00 UTC"}',
];
assert.strictEqual(rateLimitOf(journal, 'jdih.example.go.id'), "Let's Encrypt is rate-limiting it until 2026-09-23 11:40:00 UTC — try again later");
assert.strictEqual(rateLimitOf(journal, 'other.example.go.id'), null);
assert.ok(lastAcmeError(journal, 'jdih.example.go.id')!.includes('rateLimited'));
assert.ok(lastAcmeError(journal.slice(0, 1), 'jdih.example.go.id')!.startsWith('HTTP 403'));
console.log('sslProvisionService: ok');
