/**
 * What a project is called and what one status says about its apps.
 * Run: npx tsx src/lib/sources.check.ts
 */
import assert from 'assert';
import { sourceName } from './sources';
import { rollupStatus } from '../routes/sources';

// named: that; else the checkout folder, the repository, the first hostname
assert.strictEqual(sourceName({ name: ' Portal ', repository: 'https://g.com/a/b.git', path: null }), 'Portal');
// two checkouts of one repository are told apart by their folders
assert.strictEqual(sourceName({ name: null, repository: 'https://gitlab.com/depatidigital/depatinews.git', path: '/var/www/html/khamparan.co.id' }), 'khamparan.co.id');
assert.strictEqual(sourceName({ name: null, repository: 'https://gitlab.com/depatidevteam/sematapress.git', path: null }), 'sematapress');
assert.strictEqual(sourceName({ name: null, repository: 'git@github.com:acme/shop', path: null }), 'shop');
assert.strictEqual(sourceName({ name: '', repository: null, path: '/var/www/html/arusflow_9200/' }), 'arusflow_9200');
assert.strictEqual(sourceName({ name: null, repository: null, path: null }, 'blog.example.com'), 'blog.example.com');

// worst first; switched-off apps only count when all are
const app = (status: string, disabled = false) => ({ status: status as any, disabled });
assert.strictEqual(rollupStatus([app('RUNNING'), app('RUNNING')]), 'RUNNING');
assert.strictEqual(rollupStatus([app('RUNNING'), app('ERROR')]), 'ERROR');
assert.strictEqual(rollupStatus([app('ERROR'), app('BUILDING')]), 'DEPLOYING');
assert.strictEqual(rollupStatus([app('RUNNING'), app('STOPPED')]), 'PARTIAL');
assert.strictEqual(rollupStatus([app('STOPPED'), app('STOPPED')]), 'STOPPED');
assert.strictEqual(rollupStatus([app('RUNNING'), app('ERROR', true)]), 'RUNNING');
assert.strictEqual(rollupStatus([app('ERROR', true)]), 'DISABLED');
assert.strictEqual(rollupStatus([]), 'EMPTY');

console.log('sources: ok');
