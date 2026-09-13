import assert from 'assert';
import { folderRisk } from './appTeardownService';

// an app's own folder is fine
assert.strictEqual(folderRisk('/home/deploy/shop', []), null);
assert.strictEqual(folderRisk('/var/www/shop.example.com/', []), null);
// system and home folders never
for (const dir of ['/', '/root', '/home', '/home/deploy', '/var/www', '/etc', '/opt', '/var/www/html', '/app']) {
  assert.notStrictEqual(folderRisk(dir, []), null, dir);
}
// nothing to go on, or a path that could walk anywhere
assert.notStrictEqual(folderRisk(null, []), null);
assert.notStrictEqual(folderRisk('relative/dir', []), null);
assert.notStrictEqual(folderRisk('/home/deploy/shop/../..', []), null);
// shared with another app: same, inside it, or around it
assert.notStrictEqual(folderRisk('/home/deploy/shop', ['/home/deploy/shop']), null);
assert.notStrictEqual(folderRisk('/home/deploy/shop', ['/home/deploy/shop/api']), null);
assert.notStrictEqual(folderRisk('/home/deploy/shop/api', ['/home/deploy/shop']), null);
// a sibling with a common prefix is not shared
assert.strictEqual(folderRisk('/home/deploy/shop', ['/home/deploy/shop-v2']), null);

console.log('appTeardown: ok');
