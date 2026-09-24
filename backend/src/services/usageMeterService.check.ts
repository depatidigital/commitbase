import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { meterScript, parseMeter, priceOf, usageSince, RATES } from './usageMeterService';

const GiB = 1024 ** 3;

// the node's answer: slice + podman summed
const readings = parseMeter('cmorg1 5000000 1073741824 1000000 536870912\ncmorg2 0 0 0 0\n\nbad');
assert.deepStrictEqual(readings.get('cmorg1'), { cpuUsec: 6_000_000n, memBytes: 1.5 * GiB });
assert.deepStrictEqual(readings.get('cmorg2'), { cpuUsec: 0n, memBytes: 0 });

const t0 = new Date('2026-09-24T10:00:00Z');
const t5 = new Date('2026-09-24T10:05:00Z');

// no previous reading: nothing billed yet
assert.strictEqual(usageSince({ cpuUsec: null, at: null }, readings.get('cmorg1')!, t5), null);

// 5 minutes: 3 s of CPU, 1.5 GiB held for 300 s
const use = usageSince({ cpuUsec: 3_000_000n, at: t0 }, readings.get('cmorg1')!, t5)!;
assert.strictEqual(use.cpuSeconds, 3);
assert.strictEqual(use.memGbSeconds, 1.5 * 300);
assert.strictEqual(use.seconds, 300);

// the counter restarted (reboot): all of it is new
assert.strictEqual(usageSince({ cpuUsec: 9_000_000n, at: t0 }, readings.get('cmorg1')!, t5)!.cpuSeconds, 6);

// a long gap (backend was down) is capped, not billed as held throughout
assert.strictEqual(usageSince({ cpuUsec: 0n, at: new Date('2026-09-24T08:00:00Z') }, { cpuUsec: 0n, memBytes: GiB }, t5)!.seconds, 900);

// a month of 1 vCPU flat out, 1 GiB, 10 GiB stored ≈ Rp 30k + 80k + 15k
const month = 730 * 3600;
const price = priceOf({ cpuSeconds: month, memGbSeconds: month, storageGbSeconds: 10 * month });
assert.ok(Math.abs(price.cpu - 730 * RATES.cpuCoreHour) < 1e-6);
assert.ok(price.total > 120_000 && price.total < 130_000, String(price.total));

// only safe names reach the shell, and the script parses
const script = meterScript([
  { id: 'cmorg1', slug: 'depati', uid: 200000 },
  { id: 'cmorg2', slug: 'bad;rm -rf /', uid: 1 },
  { id: 'x"; rm', slug: 'ok-slug', uid: 2 },
]);
assert.ok(script.includes('cb-depati.slice') && script.includes('user@200000.service'));
assert.ok(!script.includes('rm -rf') && !script.includes('x"; rm'));
const parsed = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' });
if (!parsed.error) assert.strictEqual(parsed.status, 0, parsed.stderr);

console.log('usageMeterService: ok');
