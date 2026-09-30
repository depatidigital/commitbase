import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PARTS_DU, parseParts } from './appDiskService';

// a release with node_modules half hardlinked from elsewhere (a store), and a .next
const store = mkdtempSync(join(tmpdir(), 'store-'));
const rel = mkdtempSync(join(tmpdir(), 'rel-'));
mkdirSync(join(rel, 'node_modules'));
mkdirSync(join(rel, '.next'));
writeFileSync(join(store, 'a'), Buffer.alloc(40_000));
linkSync(join(store, 'a'), join(rel, 'node_modules', 'a'));
linkSync(join(store, 'a'), join(rel, 'node_modules', 'a2')); // same inode twice: counted once
writeFileSync(join(rel, 'node_modules', 'b'), Buffer.alloc(10_000));
writeFileSync(join(rel, '.next', 'x'), Buffer.alloc(5_000));

const { parts, shared } = parseParts(execFileSync('sh', ['-c', PARTS_DU, 'sh', rel], { encoding: 'utf8' }));
assert.deepStrictEqual(parts.map((p) => p.name), ['node_modules', '.next']);
assert.ok(parts[0]!.bytes >= 50_000 && parts[0]!.bytes < 60_000, `node_modules ${parts[0]!.bytes}`);
assert.strictEqual(shared, 40_000);
// nothing there: no parts, nothing shared
assert.deepStrictEqual(parseParts('--\n0\n'), { parts: [], shared: 0 });
assert.deepStrictEqual(parseParts(''), { parts: [], shared: 0 });
console.log('appDiskService: ok');
