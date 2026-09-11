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
const PANEL_KEY = process.env.CB_SSH_KEY_PATH || '/opt/commitbase/.ssh/id_ed25519';
const SETUP_TIMEOUT_MS = 30 * 60_000;
const LOG_TAIL = 8_000;

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
      data: { setupState: 'RUNNING' },
    });
    if (claimed.count === 0) return;

    const server = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
    const withPhp = !!(server.setupJob as { withPhp?: boolean } | null)?.withPhp;

    try {
      const pubkey = fs.readFileSync(`${PANEL_KEY}.pub`, 'utf8').trim();
      const email = acmeEmail();
      const env = [
        `PANEL_SSH_PUBKEY=${pubkey}`,
        `SERVER_IP=${server.publicIp}`,
        ...(withPhp ? ['WITH_PHP=1'] : []),
        ...(email ? [`ACME_EMAIL=${email}`] : []),
      ];

      const { stdout, stderr } = await execRoot(
        server,
        ['env', ...env, 'bash', '-c', fs.readFileSync(INSTALL_SH, 'utf8'), 'install.sh'],
        { timeout: SETUP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      );

      await prisma.server.update({
        where: { id: serverId },
        data: { setupState: 'DONE', setupError: null, setupLog: (stdout + stderr).slice(-LOG_TAIL), setupAt: new Date() },
      });
      // refresh ONLINE/provisioned now rather than at the next heartbeat
      await pingServer(server).catch(() => {});
    } catch (err: any) {
      await prisma.server.update({
        where: { id: serverId },
        data: {
          setupState: 'FAILED',
          setupError: String(err?.message || err).split('\n')[0]!.slice(0, 500),
          setupLog: String((err?.stdout ?? '') + (err?.stderr ?? '') || err?.message || err).slice(-LOG_TAIL),
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
