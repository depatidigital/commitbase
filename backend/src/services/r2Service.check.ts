/**
 * Site buckets are public — make sure repo internals never get published.
 * Run: npx tsx src/services/r2Service.check.ts
 */
import assert from 'assert';
import { isPublishable, siteLocation } from './r2Service';

// a bucket of its own (the old layout) vs a folder in the shared bucket
assert.deepStrictEqual(siteLocation('site-larika-id'), { bucket: 'site-larika-id', prefix: '' });
assert.deepStrictEqual(siteLocation('depatidigital/larika/larika.id'), { bucket: 'depatidigital', prefix: 'larika/larika.id/' });
// an empty folder would let "replace the whole site" empty the shared bucket
assert.throws(() => siteLocation('depatidigital/'));

for (const key of ['index.html', 'assets/app.js', '.well-known/security.txt', 'img/logo.svg']) {
  assert.ok(isPublishable(key), `${key} should publish`);
}
for (const key of ['.git/config', '.env', '.env.production', 'node_modules/x/index.js', 'sub/.git/HEAD', '.github/workflows/ci.yml']) {
  assert.ok(!isPublishable(key), `${key} must stay private`);
}

console.log('r2Service: ok');
