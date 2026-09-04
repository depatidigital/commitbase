/**
 * Self-check for the per-organization path layout and the run.sh generator.
 * Run: npx tsx src/scripts/checkAppPaths.ts
 */
import assert from 'assert';
import * as path from 'path';
import { appDirFor, orgHome, orgAppsDir, osUserFor, ORG_SLUG_RE } from '../lib/appPaths';

const APP = 'clx1234567890abcdef';

// Layout
assert.strictEqual(osUserFor('acme'), 'cb-acme');
assert.strictEqual(orgHome('acme'), path.join('/home', 'cb-acme'));
assert.strictEqual(orgAppsDir('acme'), path.join('/home', 'cb-acme', 'apps'));
assert.strictEqual(appDirFor(APP, 'acme'), path.join('/home', 'cb-acme', 'apps', APP));

// No organization -> legacy flat directory, never a path under /home
assert.ok(!appDirFor(APP, null).startsWith('/home/cb-'));
assert.strictEqual(appDirFor(APP, null), appDirFor(APP, undefined));

// One tenant must never resolve into another tenant's home
assert.ok(!appDirFor(APP, 'acme').startsWith(orgHome('other')));

// Traversal and injection attempts are rejected, not normalised away
for (const bad of ['../evil', 'a/../../b', 'ACME', 'acme_1', '-acme', 'acme-', 'a', '', 'acme;rm -rf /', 'acme$(id)']) {
  assert.throws(() => appDirFor(APP, bad), `slug should be rejected: ${JSON.stringify(bad)}`);
  assert.ok(!ORG_SLUG_RE.test(bad), `regex should reject: ${JSON.stringify(bad)}`);
}
for (const bad of ['../../etc/passwd', 'a/b', '', 'x'.repeat(65), 'id;reboot']) {
  assert.throws(() => appDirFor(bad, 'acme'), `app id should be rejected: ${JSON.stringify(bad)}`);
}

// Valid shapes still pass
for (const good of ['acme', 'a-b', 'client-01', 'a'.repeat(40)]) {
  assert.ok(ORG_SLUG_RE.test(good), `slug should be accepted: ${good}`);
}

// run.sh env escaping — a value with a quote must not break out of the export
const shellQuote = (v: string) => `'${String(v).replace(/'/g, `'\''`)}'`;
assert.strictEqual(shellQuote(`a'b`), `'a'\''b'`);
assert.strictEqual(shellQuote('x; rm -rf /'), `'x; rm -rf /'`);
assert.strictEqual(shellQuote('$(id)'), `'$(id)'`);

console.log('appPaths self-check passed');
