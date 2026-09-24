import { execRoot, type SshTarget } from '../lib/runner';

/**
 * Growing the root filesystem into a disk the provider made bigger: the disk
 * grows, its partition and filesystem stay the old size until told. Done
 * online — no reboot, no remount — for a plain partition or LVM, ext2/3/4,
 * xfs or btrfs.
 *
 * Fixed shell only: the devices are found on the node from what / is mounted
 * on, never taken from the request.
 */

/** Finds / and what it sits on; sets SRC FS TYPE PART DISK NUM (and VG for LVM). Rescans the disk first so a resize is seen. */
const DETECT = `
SRC=$(findmnt -no SOURCE /); FS=$(findmnt -no FSTYPE /)
TYPE=$(lsblk -no TYPE "$SRC" 2>/dev/null | head -1)
PART="$SRC"; VG=""
if [ "$TYPE" = lvm ]; then
  VG=$(lvs --noheadings -o vg_name "$SRC" 2>/dev/null | tr -d ' ')
  PART=$(pvs --noheadings -o pv_name -S vg_name="$VG" 2>/dev/null | head -1 | tr -d ' ')
fi
KPART=$(basename "$(readlink -f "$PART")")
DISK=$(lsblk -no PKNAME "/dev/$KPART" 2>/dev/null | head -1)
[ -n "$DISK" ] || DISK="$KPART"
NUM=$(cat "/sys/class/block/$KPART/partition" 2>/dev/null)
[ -w "/sys/class/block/$DISK/device/rescan" ] && echo 1 > "/sys/class/block/$DISK/device/rescan" 2>/dev/null
`;

const INSPECT = `${DETECT}
echo "source=$SRC"; echo "fstype=$FS"; echo "type=$TYPE"; echo "vg=$VG"
echo "part=$PART"; echo "disk=/dev/$DISK"; echo "partnum=$NUM"
echo "disk_size=$(lsblk -bdno SIZE "/dev/$DISK" 2>/dev/null)"
echo "part_size=$(lsblk -bdno SIZE "/dev/$KPART" 2>/dev/null)"
echo "fs_size=$(df -B1 --output=size / | tail -1 | tr -d ' ')"
echo "fs_avail=$(df -B1 --output=avail / | tail -1 | tr -d ' ')"
[ -n "$VG" ] && echo "vg_free=$(vgs --noheadings --units b --nosuffix -o vg_free "$VG" 2>/dev/null | tr -d ' ')"
if [ -n "$NUM" ]; then
  if command -v growpart >/dev/null; then echo "growpart=$(growpart --dry-run "/dev/$DISK" "$NUM" 2>&1 | head -1)"; else echo "growpart=missing"; fi
fi
`;

const GROW = `${DETECT}
if [ -n "$NUM" ]; then
  command -v growpart >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y cloud-guest-utils >/dev/null 2>&1 || { echo "growpart is missing and could not be installed" >&2; exit 3; }
  # 1 = NOCHANGE: the partition already fills the disk, the filesystem may still be behind
  growpart "/dev/$DISK" "$NUM"; rc=$?; [ $rc -le 1 ] || exit $rc
fi
if [ "$TYPE" = lvm ]; then
  pvresize "$PART" || exit $?
  # -r grows the filesystem with it; nothing free left is not an error here
  lvextend -r -l +100%FREE "$SRC" || true
else
  case "$FS" in
    ext2|ext3|ext4) resize2fs "$SRC" || exit $? ;;
    xfs) xfs_growfs / || exit $? ;;
    btrfs) btrfs filesystem resize max / || exit $? ;;
    *) echo "cannot grow a $FS filesystem" >&2; exit 2 ;;
  esac
fi
df -B1 --output=size,avail / | tail -1
`;

/** For the check: both scripts must at least parse. */
export const SCRIPTS = { INSPECT, GROW };

export type DiskLayout = {
  source: string;
  fstype: string;
  lvm: boolean;
  disk: string;
  partition: string;
  diskBytes: number;
  partitionBytes: number;
  filesystemBytes: number;
  availBytes: number;
  /** what growing would add: the partition to the disk's end, the filesystem to the partition (LVM: and the volume group's free space) */
  growableBytes: number;
  /** growpart's own word, when it had one */
  growpart: string | null;
  /** can be grown by this tool (a filesystem it knows) */
  supported: boolean;
};

const num = (value?: string) => Number(value) || 0;

/** Parse INSPECT's key=value lines. Pure. */
export function parseLayout(stdout: string): DiskLayout {
  const kv = Object.fromEntries(
    stdout
      .split('\n')
      .map((line) => /^([a-z_]+)=(.*)$/.exec(line.trim()))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [m[1]!, m[2]!]),
  );
  const lvm = kv.type === 'lvm';
  const diskBytes = num(kv.disk_size);
  const partitionBytes = num(kv.part_size);
  const filesystemBytes = num(kv.fs_size);
  // growpart says CHANGE when the partition can take more of the disk; not installed yet (growing
  // installs it), the sizes say it: a disk more than 1% bigger than its partition
  const partGain =
    /^CHANGE/.test(kv.growpart ?? '') || (kv.growpart === 'missing' && diskBytes > partitionBytes * 1.01)
      ? Math.max(0, diskBytes - partitionBytes)
      : 0;
  // a filesystem is a little smaller than its partition (metadata, reserved blocks): only a real gap counts
  const fsGap = partitionBytes - filesystemBytes;
  const fsGain = lvm ? num(kv.vg_free) : fsGap > Math.max(512 * 1024 ** 2, partitionBytes * 0.03) ? fsGap : 0;
  return {
    source: kv.source ?? '',
    fstype: kv.fstype ?? '',
    lvm,
    disk: kv.disk ?? '',
    partition: kv.part ?? '',
    diskBytes,
    partitionBytes,
    filesystemBytes,
    availBytes: num(kv.fs_avail),
    growableBytes: partGain + fsGain,
    growpart: kv.growpart ?? null,
    supported: lvm || ['ext2', 'ext3', 'ext4', 'xfs', 'btrfs'].includes(kv.fstype ?? ''),
  };
}

export async function inspectDisk(node: SshTarget): Promise<DiskLayout> {
  const { stdout } = await execRoot(node, ['sh', '-c', INSPECT], { timeout: 60_000 });
  return parseLayout(stdout);
}

/** Grow the partition (and LVM) and the filesystem into the whole disk. Returns the layout after. */
export async function growDisk(node: SshTarget): Promise<DiskLayout> {
  await execRoot(node, ['sh', '-c', GROW], { timeout: 300_000 });
  return inspectDisk(node);
}
