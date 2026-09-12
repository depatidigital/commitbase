import * as fs from 'fs';
import * as path from 'path';
import { prisma } from '../lib/prisma';
import { execRoot } from '../lib/runner';
import { pingServer } from './serverHealthService';

/**
 * Node setup queue.
 *
 * Setting a box up is `install.sh` (node-only): packages, Caddy, the SSH user
 * with its root grant, the panel's key. Instead of an operator running it on
 * the box, the panel sends the script's text over SSH and runs it as root
 * (execRoot: root login, NOPASSWD, or sudo with the stored password). Minutes
 * of apt, so nothing waits for it: a request flags the row QUEUED and the
 * worker records DONE or FAILED plus the tail of the output.
 *
 * States: NONE → QUEUED → RUNNING → DONE | FAILED. install.sh is idempotent,
 * so a run a restart cut short is simply run again.
 */

// Same depth from src/services (tsx) and dist/services (node).
const INSTALL_SH = path.resolve(__dirname, '../../../install.sh');
const PANEL_KEY = process.env.CB_SSH_KEY_PATH || '/opt/larika/.ssh/id_ed25519';
const SETUP_TIMEOUT_MS = 30 * 60_000;
const LOG_TAIL = 8_000;
/** How often the running output is written to the row, for the live log view. */
const LIVE_FLUSH_MS = 2_000;

const running = new Set<string>();

/** ACME contact for the node's Caddy. Without it install.sh registers with Let's Encrypt anonymously. */
function acmeEmail(): string | null {
  if (process.env.ACME_EMAIL) return process.env.ACME_EMAIL;
  try {
    return `admin@${new URL(process.env.APP_URL || process.env.FRONTEND_URL || '').hostname}`;
  } catch {
    return null;
  }
}

export async function queueServerSetup(serverId: string, opts: { withPhp?: boolean } = {}): Promise<void> {
  await prisma.server.update({
    where: { id: serverId },
    data: { setupState: 'QUEUED', setupError: null, setupJob: { withPhp: !!opts.withPhp } },
  });
  void runServerSetup(serverId);
}

export async function runServerSetup(serverId: string): Promise<void> {
  if (running.has(serverId)) return;
  running.add(serverId);

  try {
    const claimed = await prisma.server.updateMany({
      where: { id: serverId, setupState: 'QUEUED' },
      // the previous run's output would read as this run's
      data: { setupState: 'RUNNING', setupLog: null },
    });
    if (claimed.count === 0) return;

    const server = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
    const withPhp = !!(server.setupJob as { withPhp?: boolean } | null)?.withPhp;

    // Output as it arrives, stdout and stderr interleaved in order. Written to
    // the row every LIVE_FLUSH_MS so the Servers page can follow along by polling.
    // ponytail: DB polling, not a socket — 2s lag is fine for minutes of apt.
    let live = '';
    let dirty = false;
    let flushing: Promise<unknown> = Promise.resolve();
    const flush = () => {
      if (!dirty) return;
      dirty = false;
      flushing = prisma.server.update({ where: { id: serverId }, data: { setupLog: live } }).catch(() => {});
    };
    const ticker = setInterval(flush, LIVE_FLUSH_MS);
    const onOutput = (text: string) => {
      // install.sh colours its headings for a terminal; the log view is plain text
      live = (live + text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')).slice(-LOG_TAIL);
      dirty = true;
    };
    // a live write landing after the final one would overwrite it with an older tail
    const stopLive = async () => {
      clearInterval(ticker);
      await flushing;
    };

    try {
      // Authorising the panel's key on the node is only needed so the panel can
      // log in as the SSH user by key later. A server reached by password (or
      // with its own key) keeps working without it, so a missing key is skipped.
      const pubkey = fs.existsSync(`${PANEL_KEY}.pub`) ? fs.readFileSync(`${PANEL_KEY}.pub`, 'utf8').trim() : '';
      if (!pubkey) onOutput(`note: no panel key at ${PANEL_KEY}.pub - not authorizing one on this node\n`);
      const email = acmeEmail();
      const env = [
        ...(pubkey ? [`PANEL_SSH_PUBKEY=${pubkey}`] : []),
        `SERVER_IP=${server.publicIp}`,
        ...(withPhp ? ['WITH_PHP=1'] : []),
        ...(email ? [`ACME_EMAIL=${email}`] : []),
      ];

      const { stdout, stderr } = await execRoot(
        server,
        ['env', ...env, 'bash', '-c', fs.readFileSync(INSTALL_SH, 'utf8'), 'install.sh'],
        { timeout: SETUP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, onOutput },
      );

      await stopLive();
      await prisma.server.update({
        where: { id: serverId },
        data: { setupState: 'DONE', setupError: null, setupLog: live || (stdout + stderr).slice(-LOG_TAIL), setupAt: new Date() },
      });
      // refresh ONLINE/provisioned now rather than at the next heartbeat
      await pingServer(server).catch(() => {});
    } catch (err: any) {
      await stopLive();
      await prisma.server.update({
        where: { id: serverId },
        data: {
          setupState: 'FAILED',
          setupError: String(err?.message || err).split('\n')[0]!.slice(0, 500),
          setupLog: (live || String((err?.stdout ?? '') + (err?.stderr ?? '') || err?.message || err)).slice(-LOG_TAIL),
        },
      });
    }
  } catch (err) {
    console.error(`Server setup worker failed for ${serverId}:`, err);
  } finally {
    running.delete(serverId);
  }
}

/** Cron sweep: requeue RUNNING rows a restart orphaned, then run every QUEUED server. */
export async function setupQueuedServers(): Promise<string> {
  // ponytail: "not in this process's set" = orphaned, valid for one replica only (see cron.ts).
  await prisma.server.updateMany({
    where: { setupState: 'RUNNING', id: { notIn: [...running] } },
    data: { setupState: 'QUEUED' },
  });

  const queued = await prisma.server.findMany({ where: { setupState: 'QUEUED' }, select: { id: true } });
  for (const server of queued) await runServerSetup(server.id);
  return queued.length === 0 ? 'nothing queued' : `${queued.length} server(s) set up`;
}
