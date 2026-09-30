/** Self-check: npx tsx src/services/redisService.check.ts */
import assert from 'assert';
import { redisPortFor, redisConfigOf } from './redisService';

assert.strictEqual(redisPortFor(200_000), 30_000);
assert.strictEqual(redisPortFor(200_042), 30_042);
assert.throws(() => redisPortFor(null));
assert.throws(() => redisPortFor(1001));
assert.throws(() => redisPortFor(300_000));
assert.deepStrictEqual(redisConfigOf({ serverId: 's1', index: 3 }), { serverId: 's1', index: 3 });
assert.throws(() => redisConfigOf({ serverId: 's1' }));
console.log('redisService: ok');
