import assert from 'node:assert';
import { sourceBucket } from '../lib/sources';

assert.strictEqual(sourceBucket('RUNNING', 'SUCCESS', 0), 'running');
assert.strictEqual(sourceBucket('DEPLOYING', null, 0), 'running');
assert.strictEqual(sourceBucket('PARTIAL', 'SUCCESS', 0), 'running'); // a stopped app is on purpose
assert.strictEqual(sourceBucket('RUNNING', 'SUCCESS', 1), 'problem'); // uptime says down
assert.strictEqual(sourceBucket('RUNNING', 'FAILED', 0), 'problem');
assert.strictEqual(sourceBucket('ERROR', 'SUCCESS', 0), 'problem');
assert.strictEqual(sourceBucket('STOPPED', null, 0), 'stopped');
assert.strictEqual(sourceBucket('DISABLED', 'FAILED', 0), 'problem'); // a failed deploy still wants a look
assert.strictEqual(sourceBucket('EMPTY', undefined, 0), 'stopped');
console.log('sourceBucket ok');
