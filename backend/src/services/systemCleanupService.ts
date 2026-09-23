import { execRoot, type SshTarget } from '../lib/runner';

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
const PKG_CACHES = '/root/.npm/_cacache /home/*/.npm/_cacache /root/.cache/yarn /home/*/.cache/yarn';
const OLD_TMP = `find /tmp /var/tmp -xdev -type f -mtime +7`;

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
  crashDumps: {
    measure: du('/var/crash/* /var/lib/systemd/coredump/*'),
    clean: 'rm -rf -- /var/crash/* /var/lib/systemd/coredump/*',
  },
  oldTmp: {
    measure: sum(OLD_TMP),
    clean: `${OLD_TMP} -delete`,
  },
} as const;

export type SystemTarget = keyof typeof SYSTEM_TARGETS;
export const SYSTEM_TARGET_IDS = Object.keys(SYSTEM_TARGETS) as SystemTarget[];

/** Bytes per target; a target missing from the node is left out. One SSH round trip. */
export async function measureSystem(node: SshTarget): Promise<Partial<Record<SystemTarget, number>>> {
  const script = SYSTEM_TARGET_IDS.map((id) => `printf '${id}\\t%s\\n' "$(${SYSTEM_TARGETS[id].measure})"`).join('\n');
  const { stdout } = await execRoot(node, ['sh', '-c', script], { timeout: 300_000 });
  const out: Partial<Record<SystemTarget, number>> = {};
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
  for (const id of targets) {
    if (before[id] === undefined) continue;
    await execRoot(node, ['sh', '-c', SYSTEM_TARGETS[id].clean], { timeout: 300_000 }).catch((error: any) => {
      console.warn(`system cleanup ${id}: ${error?.stderr || error?.message || error}`);
      failed.push(id);
    });
  }
  const after = await measureSystem(node);
  const freedBytes = targets.reduce((sum, id) => sum + Math.max(0, (before[id] ?? 0) - (after[id] ?? 0)), 0);
  return { freedBytes, failed };
}
