import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { parseLayout, SCRIPTS } from './diskGrowService';

const G = 1024 ** 3;

// a disk grown from 40 to 80 GB, the partition and filesystem still 40
const grown = parseLayout(
  [
    'source=/dev/vda1', 'fstype=ext4', 'type=part', 'vg=', 'part=/dev/vda1', 'disk=/dev/vda', 'partnum=1',
    `disk_size=${80 * G}`, `part_size=${40 * G}`, `fs_size=${39 * G}`, `fs_avail=${1 * G}`,
    'growpart=CHANGE: partition=1 start=2048 old: size=83884032 end=83886080 new: size=167770079 end=167772127',
  ].join('\n'),
);
assert.strictEqual(grown.growableBytes, 40 * G); // the partition's gain; the filesystem's 1 GB is its own metadata
assert.strictEqual(grown.supported, true);
assert.strictEqual(grown.lvm, false);

// partition already grown, filesystem not
const halfway = parseLayout(
  ['source=/dev/vda1', 'fstype=xfs', 'type=part', `disk_size=${80 * G}`, `part_size=${80 * G}`, `fs_size=${40 * G}`, 'growpart=NOCHANGE: partition 1 is size 167770079'].join('\n'),
);
assert.strictEqual(halfway.growableBytes, 40 * G);

// nothing to do
const done = parseLayout(['source=/dev/vda1', 'fstype=ext4', 'type=part', `disk_size=${80 * G}`, `part_size=${80 * G}`, `fs_size=${79 * G}`, 'growpart=NOCHANGE'].join('\n'));
assert.strictEqual(done.growableBytes, 0);

// LVM: the partition can grow, and the volume group has free space already
const lvm = parseLayout(
  ['source=/dev/mapper/ubuntu--vg-ubuntu--lv', 'fstype=ext4', 'type=lvm', 'vg=ubuntu-vg', `disk_size=${100 * G}`, `part_size=${98 * G}`, `fs_size=${48 * G}`, `vg_free=${50 * G}`, 'growpart=NOCHANGE'].join('\n'),
);
assert.strictEqual(lvm.lvm, true);
assert.strictEqual(lvm.growableBytes, 50 * G);

assert.strictEqual(parseLayout('fstype=zfs\ntype=part').supported, false);
// the scripts parse (sh -n: read, not run)
for (const [name, script] of Object.entries(SCRIPTS)) {
  const out = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' });
  if (out.error) break; // no sh here: skip
  assert.strictEqual(out.status, 0, `${name}: ${out.stderr}`);
}
console.log('diskGrowService: ok');
