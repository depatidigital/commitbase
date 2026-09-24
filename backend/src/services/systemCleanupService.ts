import { execOrg, execRoot, type SshTarget } from '../lib/runner';
import { prisma } from '../lib/prisma';

/**
 * The node's own clutter, outside any app tree: logs, package caches, crash
 * dumps, temp files. Each target is a fixed shell snippet — nothing from the
 * request reaches the shell but a target id checked against this list.
 *
 * `measure` prints the bytes the clean would free, or nothing when the target
 * does not exist on this node (no docker, no apt). Measured again after
 * cleaning, so what was freed is a fact.
 */

/** Summed file sizes of whatever `find` matches; 0 when nothing does. */
const sum = (find: string) => `${find} -printf '%s\\n' 2>/dev/null | awk '{s+=$1} END{print s+0}'`;
/** `du` total of the paths that exist; globs that match nothing are dropped by `ls -d`. */
const du = (paths: string) => `{ set -- $(ls -d ${paths} 2>/dev/null); if [ $# -gt 0 ]; then du -scb -- "$@" 2>/dev/null | tail -1 | cut -f1; else echo 0; fi; }`;

const ROTATED_LOGS = `find /var/log -type f \\( -name '*.gz' -o -name '*.[0-9]' -o -name '*.old' -o -name '*.xz' \\)`;
const PM2_LOGS = `find /root/.pm2/logs /home/*/.pm2/logs -type f -name '*.log'`;
// every package manager's download cache, in root's home, the users' and the build user's (/var/lib/larika-build)
const CACHE_DIRS = ['.npm/_cacache', '.cache/yarn', '.local/share/pnpm/store', '.cache/pnpm', '.cache/pip', '.cache/composer', '.composer/cache', '.bun/install/cache'];
const PKG_CACHES = ['/root', '/home/*', '/var/lib/*'].flatMap((home) => CACHE_DIRS.map((dir) => `${home}/${dir}`)).join(' ');
const OLD_TMP = `find /tmp /var/tmp -xdev -type f -mtime +7`;
// logs still being written, grown past 50 MB: emptied in place (the writer keeps its handle); the journal has its own target
const BIG_LOGS = `find /var/log -xdev -type f -size +50M ! -path '/var/log/journal/*' \\( -name '*.log' -o -name syslog -o -name messages -o -name kern.log -o -name '*.err' \\)`;
// snaps keep their previous revisions, disabled: path per revision
const OLD_SNAPS = `snap list --all 2>/dev/null | awk '$NF ~ /disabled/'`;

export const JOURNAL_KEEP = '7d';

export const SYSTEM_TARGETS = {
  journal: {
    // everything older than JOURNAL_KEEP; the whole journal is the upper bound, measured as such
    measure: `command -v journalctl >/dev/null && journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[KMGT]?' | head -1 | numfmt --from=iec`,
    clean: `journalctl --vacuum-time=${JOURNAL_KEEP}`,
  },
  rotatedLogs: {
    measure: sum(ROTATED_LOGS),
    clean: `${ROTATED_LOGS} -delete`,
  },
  pm2Logs: {
    // truncated, not deleted: pm2 keeps them open
    measure: sum(PM2_LOGS),
    clean: `${PM2_LOGS} -exec truncate -s 0 {} + 2>/dev/null; true`,
  },
  aptCache: {
    measure: `command -v apt-get >/dev/null && ${du('/var/cache/apt/archives/*.deb')}`,
    clean: 'apt-get clean',
  },
  packageCaches: {
    measure: du(PKG_CACHES),
    clean: `rm -rf -- ${PKG_CACHES}`,
  },
  docker: {
    // dangling images and build cache only: stopped containers and tagged images may be an app's
    measure:
      `command -v docker >/dev/null && { ` +
      `docker images -qf dangling=true | xargs -r docker image inspect --format '{{.Size}}'; ` +
      `docker system df --format '{{.Type}}|{{.Reclaimable}}' | awk -F'|' '$1=="Build Cache"{split($2,a," "); u=a[1]; gsub(/[0-9.]/,"",u); print int((a[1]+0)*(u=="kB"?1e3:u=="MB"?1e6:u=="GB"?1e9:u=="TB"?1e12:1))}'; ` +
      `} | awk '{s+=$1} END{print s+0}'`,
    clean: 'docker image prune -f && docker builder prune -af',
  },
  aptAutoremove: {
    // what apt itself says nothing needs anymore: old kernels, their headers, orphaned libraries.
    // Ubuntu keeps the running kernel and the one before it
    measure:
      `command -v apt-get >/dev/null && apt-get -s autoremove 2>/dev/null | awk '/^Remv /{print $2}' | ` +
      `xargs -r dpkg-query -Wf '\${Installed-Size}\n' 2>/dev/null | awk '{s+=$1*1024} END{print s+0}'`,
    clean: 'DEBIAN_FRONTEND=noninteractive apt-get autoremove --purge -y',
  },
  oldSnaps: {
    measure: `command -v snap >/dev/null && ${OLD_SNAPS} | awk '{print "/var/lib/snapd/snaps/"$1"_"$3".snap"}' | xargs -r du -b 2>/dev/null | awk '{s+=$1} END{print s+0}'`,
    clean: `${OLD_SNAPS} | awk '{print $1, $3}' | while read -r name rev; do snap remove "$name" --revision="$rev"; done`,
  },
  bigLogs: {
    measure: sum(BIG_LOGS),
    clean: `${BIG_LOGS} -exec truncate -s 0 {} + 2>/dev/null; true`,
  },
  crashDumps: {
    measure: du('/var/crash/* /var/lib/systemd/coredump/*'),
    clean: 'rm -rf -- /var/crash/* /var/lib/systemd/coredump/*',
  },
  oldTmp: {
    measure: sum(OLD_TMP),
    clean: `${OLD_TMP} -delete`,
  },
} as const;

/**
 * Compose stacks run in each organization's rootless Podman (cb-<slug>), where
 * root's `docker` never looks. A stack is the panel's when its compose project
 * is `cb-<slug>-<appId>` (composeService.projectName) and a leftover when that
 * app is gone. Stacks the panel did not make are never touched.
 */
const PODMAN_TARGETS = ['podman', 'podmanVolumes'] as const;
type PodmanTarget = (typeof PODMAN_TARGETS)[number];

export type SystemTarget = keyof typeof SYSTEM_TARGETS | PodmanTarget;
export const SYSTEM_TARGET_IDS = [...Object.keys(SYSTEM_TARGETS), ...PODMAN_TARGETS] as SystemTarget[];

const isPodman = (id: SystemTarget): id is PodmanTarget => (PODMAN_TARGETS as readonly string[]).includes(id);

type OrgScan = {
  user: { slug: string; uid: number };
  /** containers of deleted apps' stacks */
  orphans: string[];
  /** images no container would use once the orphans are gone — what `image prune -a` removes */
  imageBytes: number;
  /** volumes of deleted apps' stacks: their data */
  volumes: { name: string; mountpoint: string }[];
};

/** Every org user's podman, or null when the node has no podman. An org podman cannot read is left out. */
async function scanPodman(node: SshTarget): Promise<OrgScan[] | null> {
  const passwd = await execRoot(node, ['sh', '-c', 'command -v podman >/dev/null && getent passwd'], { timeout: 60_000 }).catch(() => null);
  if (!passwd) return null;
  const users = passwd.stdout.split('\n').flatMap((line) => {
    const m = /^cb-([a-z0-9-]+):[^:]*:(\d+):/.exec(line);
    return m ? [{ slug: m[1]!, uid: Number(m[2]) }] : [];
  });
  const live = new Set((await prisma.application.findMany({ select: { id: true } })).map((app) => app.id.toLowerCase()));

  const scans = await Promise.all(
    users.map(async (user): Promise<OrgScan | null> => {
      const podman = async (args: string[]): Promise<any[]> =>
        JSON.parse((await execOrg(node, user.slug, user.uid, ['podman', ...args], { timeout: 120_000 })).stdout || '[]') ?? [];
      try {
        const [containers, images, volumes] = await Promise.all([
          podman(['ps', '-a', '--format', 'json']),
          podman(['images', '--format', 'json']),
          podman(['volume', 'ls', '--format', 'json']),
        ]);
        const prefix = `cb-${user.slug}-`;
        const orphan = (labels: any) => {
          const project = labels?.['com.docker.compose.project'];
          return typeof project === 'string' && project.startsWith(prefix) && !live.has(project.slice(prefix.length));
        };
        const used = new Set(containers.filter((c) => !orphan(c.Labels)).map((c) => c.ImageID));
        return {
          user,
          orphans: containers.filter((c) => orphan(c.Labels)).map((c) => String(c.Id)),
          // ponytail: sums image sizes, so layers two images share count twice — an upper bound, like the journal's
          imageBytes: images.filter((i) => !used.has(i.Id)).reduce((sum, i) => sum + (Number(i.Size) || 0), 0),
          volumes: volumes
            .filter((v) => orphan(v.Labels) && typeof v.Mountpoint === 'string' && v.Mountpoint.startsWith('/'))
            .map((v) => ({ name: String(v.Name), mountpoint: v.Mountpoint as string })),
        };
      } catch (error: any) {
        console.warn(`podman scan of cb-${user.slug}: ${error?.stderr || error?.message || error}`);
        return null;
      }
    }),
  );
  return scans.filter((scan): scan is OrgScan => scan !== null);
}

async function measurePodman(node: SshTarget): Promise<Partial<Record<PodmanTarget, number>>> {
  const scans = await scanPodman(node);
  if (!scans) return {};
  const mounts = scans.flatMap((scan) => scan.volumes.map((v) => v.mountpoint));
  // as root: a volume's files belong to the container's mapped uids, not the org user
  const du = mounts.length ? await execRoot(node, ['du', '-scb', '--', ...mounts], { timeout: 300_000 }).catch(() => null) : null;
  // the last line is the total
  const volumeBytes = Number(du?.stdout.trim().split('\n').pop()?.split('\t')[0]) || 0;
  return { podman: scans.reduce((sum, scan) => sum + scan.imageBytes, 0), podmanVolumes: volumeBytes };
}

/** Scanned again rather than trusting the measure: an app deployed since then is not a leftover. */
async function cleanPodman(node: SshTarget, id: PodmanTarget): Promise<void> {
  for (const scan of (await scanPodman(node)) ?? []) {
    const podman = (args: string[]) => execOrg(node, scan.user.slug, scan.user.uid, ['podman', ...args], { timeout: 300_000 });
    if (id === 'podman') {
      if (scan.orphans.length) await podman(['rm', '-f', '--', ...scan.orphans]);
      // images no container uses (a stopped stack's containers still hold theirs), and the networks likewise
      await podman(['image', 'prune', '-af']);
      await podman(['network', 'prune', '-f']);
    } else if (scan.volumes.length) {
      await podman(['volume', 'rm', '-f', '--', ...scan.volumes.map((v) => v.name)]);
    }
  }
}

/** Bytes per target; a target missing from the node is left out. */
export async function measureSystem(node: SshTarget): Promise<Partial<Record<SystemTarget, number>>> {
  const ids = Object.keys(SYSTEM_TARGETS) as (keyof typeof SYSTEM_TARGETS)[];
  const script = ids.map((id) => `printf '${id}\\t%s\\n' "$(${SYSTEM_TARGETS[id].measure})"`).join('\n');
  const [{ stdout }, podman] = await Promise.all([execRoot(node, ['sh', '-c', script], { timeout: 300_000 }), measurePodman(node)]);
  const out: Partial<Record<SystemTarget, number>> = { ...podman };
  for (const line of stdout.split('\n')) {
    const [id = '', value] = line.split('\t');
    if (id in SYSTEM_TARGETS && value && /^\d+$/.test(value.trim())) out[id as SystemTarget] = Number(value);
  }
  return out;
}

/** Clean the chosen targets, one after the other; one that fails is reported, not fatal. */
export async function cleanSystem(node: SshTarget, targets: SystemTarget[]): Promise<{ freedBytes: number; failed: string[] }> {
  const before = await measureSystem(node);
  const failed: string[] = [];
  // the leftover containers first: a volume one of them still holds would take it along anyway
  for (const id of [...targets].sort((a, b) => Number(b === 'podman') - Number(a === 'podman'))) {
    if (before[id] === undefined) continue;
    await (isPodman(id) ? cleanPodman(node, id) : execRoot(node, ['sh', '-c', SYSTEM_TARGETS[id].clean], { timeout: 300_000 })).catch((error: any) => {
      console.warn(`system cleanup ${id}: ${error?.stderr || error?.message || error}`);
      failed.push(id);
    });
  }
  const after = await measureSystem(node);
  const freedBytes = targets.reduce((sum, id) => sum + Math.max(0, (before[id] ?? 0) - (after[id] ?? 0)), 0);
  return { freedBytes, failed };
}
