/**
 * Site buckets are public — make sure repo internals never get published.
 * Run: npx tsx src/services/r2Service.check.ts
 */
import assert from 'assert';
import { isPublishable } from './r2Service';

for (const key of ['index.html', 'assets/app.js', '.well-known/security.txt', 'img/logo.svg']) {
  assert.ok(isPublishable(key), `${key} should publish`);
}
for (const key of ['.git/config', '.env', '.env.production', 'node_modules/x/index.js', 'sub/.git/HEAD', '.github/workflows/ci.yml']) {
  assert.ok(!isPublishable(key), `${key} must stay private`);
}

console.log('r2Service: ok');
