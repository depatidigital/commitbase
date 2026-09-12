/**
 * Self-check for the static release pointer: npx tsx src/services/staticReleaseService.check.ts
 */
import assert from 'assert';
import { inFolder, releaseFolder, servingFolder, siteRootOrigin } from './staticReleaseService';

const root = 'cdn.depatidigital.com/larika/larika.id';
const folder = releaseFolder('cmabc123');
const pointer = inFolder(root, folder);

assert.strictEqual(pointer, 'cdn.depatidigital.com/larika/larika.id/deploys/cmabc123');
// rollback takes the root back off whatever release the pointer is on
assert.strictEqual(siteRootOrigin(pointer), root);
assert.strictEqual(siteRootOrigin(root), root);
assert.strictEqual(servingFolder(pointer), folder);
// a site from before releases serves its root
assert.strictEqual(servingFolder(root), '');
assert.strictEqual(servingFolder(null), '');
assert.strictEqual(inFolder(root, ''), root);

// a bucket of its own: the pointer is the r2.dev host plus the folder
assert.strictEqual(siteRootOrigin('pub-1.r2.dev/deploys/x'), 'pub-1.r2.dev');
// a domain that merely contains "deploys" is not a release folder
assert.strictEqual(servingFolder('cdn.example.com/deploys.example.com'), '');

console.log('staticReleaseService: pointer helpers OK');
