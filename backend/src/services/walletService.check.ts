// yarn check:wallet — when a workspace's balance warns, stops and resumes its apps.
import assert from 'node:assert/strict';
import { daysOf, guardStep, MICRO, negativeLimit } from './walletService';

const rp = (n: number) => BigInt(n) * MICRO;
const now = Date.now();
const base = { suspended: false, notice: null, noticeAt: null, now };

// the limit: 7 days of spend, never under Rp 10,000
assert.equal(negativeLimit(rp(700)), rp(10_000), 'Rp 700/day: 7 days is Rp 4,900, so Rp 10,000');
assert.equal(negativeLimit(rp(5_000)), rp(35_000));
assert.equal(negativeLimit(0n), rp(10_000));

const perDay = rp(5_000);
// plenty left: nothing
assert.deepEqual(guardStep({ ...base, balance: rp(50_000), perDay }), { do: 'none', notice: null, mail: false });
// under 3 days: LOW, mailed once
assert.deepEqual(guardStep({ ...base, balance: rp(14_000), perDay }), { do: 'none', notice: 'LOW', mail: true });
assert.equal(guardStep({ ...base, balance: rp(14_000), perDay, notice: 'LOW' }).mail, false);
// nothing spent (static sites, AI only): never LOW
assert.equal(guardStep({ ...base, balance: 0n, perDay: 0n }).notice, null);
// below zero: NEGATIVE, mailed again once a day
assert.deepEqual(guardStep({ ...base, balance: rp(-1), perDay }), { do: 'none', notice: 'NEGATIVE', mail: true });
assert.equal(guardStep({ ...base, balance: rp(-1), perDay, notice: 'NEGATIVE', noticeAt: new Date(now - 3_600_000) }).mail, false);
assert.equal(guardStep({ ...base, balance: rp(-1), perDay, notice: 'NEGATIVE', noticeAt: new Date(now - 21 * 3_600_000) }).mail, true);
// at the limit: stop, mailed
assert.deepEqual(guardStep({ ...base, balance: rp(-34_999), perDay }).do, 'none');
assert.deepEqual(guardStep({ ...base, balance: rp(-35_000), perDay }), { do: 'stop', notice: 'STOPPED', mail: true });
// stopped: stays stopped (no more mail) until above zero, then resumes
assert.deepEqual(guardStep({ ...base, suspended: true, balance: rp(-40_000), perDay }), { do: 'keep-stopped', notice: 'STOPPED', mail: false });
assert.deepEqual(guardStep({ ...base, suspended: true, balance: 0n, perDay }).do, 'keep-stopped', 'zero is not enough to start again');
assert.deepEqual(guardStep({ ...base, suspended: true, balance: rp(1), perDay }), { do: 'resume', notice: null, mail: false });

assert.equal(daysOf(rp(14_000), perDay), 2.8);
assert.equal(daysOf(rp(1), 0n), null);

console.log('wallet: ok');
process.exit(0);
