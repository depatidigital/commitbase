import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { heldBetween, meterScript, parseMeter, priceOf, spreadHours, usageSince, wibDayStart, RATES } from './usageMeterService';

const GiB = 1024 ** 3;

// the node's answer: slice + podman summed
const readings = parseMeter('cmorg1 5000000 1073741824 1000000 536870912 7340032\ncmorg2 0 0 0 0\n\nbad');
assert.deepStrictEqual(readings.get('cmorg1'), { cpuUsec: 6_000_000n, memBytes: 1.5 * GiB, journalBytes: 7340032 });
assert.deepStrictEqual(readings.get('cmorg2'), { cpuUsec: 0n, memBytes: 0, journalBytes: 0 });

const t0 = new Date('2026-09-24T10:00:00Z');
const t5 = new Date('2026-09-24T10:05:00Z');
const cm1 = readings.get('cmorg1')!;

// no previous reading: nothing billed yet
assert.strictEqual(usageSince({ cpuUsec: null, memBytes: null, at: null }, cm1, t5), null);

// 5 minutes: 3 s of CPU, 1.5 GiB held for 300 s
const use = usageSince({ cpuUsec: 3_000_000n, memBytes: BigInt(GiB), at: t0 }, cm1, t5)!;
assert.strictEqual(use.cpuSeconds, 3);
assert.strictEqual(use.memGbSeconds, 1.5 * 300);
assert.deepStrictEqual([use.cpuFrom, use.memFrom], [t0, t0]);

// the counter restarted (reboot): all of it is new
assert.strictEqual(usageSince({ cpuUsec: 9_000_000n, memBytes: null, at: t0 }, cm1, t5)!.cpuSeconds, 6);

// a 2 h gap (backend was down): all its CPU, over all of it; memory at the lower reading, throughout
const t8 = new Date('2026-09-24T08:05:00Z');
const gap = usageSince({ cpuUsec: 0n, memBytes: BigInt(GiB), at: t8 }, cm1, t5)!;
assert.strictEqual(gap.cpuSeconds, 6);
assert.strictEqual(gap.cpuFrom, t8);
assert.strictEqual(gap.memGbSeconds, 1 * 7200);
assert.deepStrictEqual(gap.memFrom, t8);
// a day's gap: memory for the last 6 h only — past that nothing is known
const long = usageSince({ cpuUsec: 0n, memBytes: BigInt(4 * GiB), at: new Date('2026-09-23T10:05:00Z') }, cm1, t5)!;
assert.strictEqual(long.memGbSeconds, 1.5 * 6 * 3600);
assert.deepStrictEqual(long.memFrom, new Date('2026-09-24T04:05:00Z'));

// spread over the hours touched, by share
assert.deepStrictEqual(spreadHours(new Date('2026-09-24T09:50:00Z'), new Date('2026-09-24T10:10:00Z')), [
  { hour: new Date('2026-09-24T09:00:00Z'), share: 0.5 },
  { hour: new Date('2026-09-24T10:00:00Z'), share: 0.5 },
]);
assert.deepStrictEqual(spreadHours(t5, t5), [{ hour: t0, share: 1 }]);
assert.ok(Math.abs(spreadHours(t8, t5).reduce((sum, h) => sum + h.share, 0) - 1) < 1e-9);

// WIB days: 16:59 UTC is still the 24th in Jakarta, 17:00 UTC is the 25th
assert.strictEqual(new Date(wibDayStart(Date.parse('2026-09-24T16:59:00Z'))).toISOString(), '2026-09-23T17:00:00.000Z');
assert.strictEqual(new Date(wibDayStart(Date.parse('2026-09-24T17:00:00Z'))).toISOString(), '2026-09-24T17:00:00.000Z');

// a backfilled day: each service from when it was made, disk and R2 apart, the journal since the workspace
const day = Date.parse('2026-09-01T17:00:00Z');
const held = heldBetween(
  [
    { createdAt: new Date('2026-01-01'), diskBytes: 10n * BigInt(GiB), type: 'NODEJS', staticBucket: null },
    { createdAt: new Date(day + 43_200_000), diskBytes: 4n * BigInt(GiB), type: 'NODEJS', staticBucket: null }, // made at noon: half the day
    { createdAt: new Date('2026-01-01'), diskBytes: BigInt(GiB), type: 'STATIC', staticBucket: 'site' },
    { createdAt: new Date(day + 2 * 86_400_000), diskBytes: 99n * BigInt(GiB), type: 'NODEJS', staticBucket: null }, // not made yet
  ],
  { bytes: GiB, since: new Date('2026-01-01') },
  day,
  day + 86_400_000,
);
assert.deepStrictEqual(held, { diskBytes: 12 * GiB, journalBytes: GiB, objectBytes: GiB });

// a month of 1 vCPU flat out, 1 GiB, 10 GiB stored ≈ Rp 30k + 80k + 15k
const month = 730 * 3600;
const price = priceOf({ cpuSeconds: month, memGbSeconds: month, storageGbSeconds: 10 * month });
assert.ok(Math.abs(price.cpu - 730 * RATES.cpuCoreHour) < 1e-6);
assert.ok(price.total > 120_000 && price.total < 130_000, String(price.total));
// storage by the day: a whole 30-day month of 34 GB is exactly 34 × Rp 1,500, whatever the month's length
assert.ok(Math.abs(priceOf({ cpuSeconds: 0, memGbSeconds: 0, storageGbSeconds: 34 * 30 * 86_400 }, 30).storage - 34 * 1500) < 1e-6);
assert.ok(Math.abs(priceOf({ cpuSeconds: 0, memGbSeconds: 0, storageGbSeconds: 34 * 31 * 86_400 }, 31).storage - 34 * 1500) < 1e-6);
// R2 apart, at its own price: a month of 10 GB there is 10 × Rp 750
const r2 = priceOf({ cpuSeconds: 0, memGbSeconds: 0, storageGbSeconds: 0, objectGbSeconds: 10 * 30 * 86_400 }, 30);
assert.ok(Math.abs(r2.object - 10 * RATES.objectGbMonth) < 1e-6 && r2.storage === 0);

// only safe names reach the shell, and the script parses
const script = meterScript([
  { id: 'cmorg1', slug: 'depati', uid: 200000 },
  { id: 'cmorg2', slug: 'bad;rm -rf /', uid: 1 },
  { id: 'x"; rm', slug: 'ok-slug', uid: 2 },
]);
assert.ok(script.includes('cb-depati.slice') && script.includes('user@200000.service') && script.includes('jr 200000'));
assert.ok(!script.includes('rm -rf') && !script.includes('x"; rm'));
const parsed = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' });
if (!parsed.error) assert.strictEqual(parsed.status, 0, parsed.stderr);

console.log('usageMeterService: ok');
