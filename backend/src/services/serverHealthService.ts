import { prisma } from '../lib/prisma';
import { recordBeat } from './heartbeatService';
import { execRoot, RemoteExecError, type SshTarget } from '../lib/runner';

/**
 * Node heartbeat.
 *
 * With one box, "is the server up?" answered itself — if it were down, nothing
 * would be asking. With several, a node can be unreachable for hours while the
 * panel serves happily, and the first sign would be a tenant's failed deploy.
 *
 * The check is deliberately the thing the control plane actually needs, not a
 * ping: it asks for passwordless root over the same SSH channel provisioning
 * uses. That covers the whole chain in one round trip — network, sshd, key
 * authorization, and the root grant the runner scripts are executed under.
 *
 * It reports those as two facts, not one. A node that answers with a non-zero
 * exit has already proved the hard half works: the network, sshd and the
 * credential are all fine, and only the root grant is missing. Calling that
 * OFFLINE sends an operator hunting a network fault that does not exist, and
 * makes an unprovisioned box untestable.
 */

const PING_TIMEOUT_MS = 10_000;

export type ServerStatus = 'ONLINE' | 'OFFLINE' | 'UNKNOWN';

export interface PingResult {
  id: string;
  name: string;
  status: ServerStatus;
  /** Whether the runner scripts are installed. False on a reachable but bare box. */
  provisioned: boolean;
  error?: string;
}

/** Check one node and record the verdict. Never throws — an unreachable node is data, not an exception. */
/** Loopback names — a node that is the box the control plane runs on. */
const SELF_HOSTS = ['127.0.0.1', '::1', 'localhost'];

/**
 * The failure mode nobody guesses on the first try: the control plane reaches
 * its own box over SSH like any other node, so that box has to authorise the
 * control plane's own key. When it does not, the SSH error reads like a network
 * problem, and there is no network involved.
 */
function explainSshFailure(server: SshTarget, error: string): string {
  const isSelf = SELF_HOSTS.includes(server.hostname.trim().toLowerCase());
  const refused = /connection|authentic|publickey|denied|refused|timed out|ECONNREFUSED/i.test(error);

  if (!isSelf || !refused) return error;

  return `${error} — this node is the control plane's own box, which still has to authorise its key: check that ${server.sshKeyPath}.pub is in ~${server.sshUser}/.ssh/authorized_keys and that sshd accepts connections on ${server.hostname}`;
}

/**
 * Snapshot a node's Caddy config the first time it is seen healthy. Cheap when
 * one already exists: the snapshot skips a config that has not changed.
 */
async function ensureSnapshot(server: SshTarget & { name: string }): Promise<void> {
  try {
    const { snapshotNode } = await import('./caddySnapshotService');
    const result = await snapshotNode(server);
    if (!result.includes('unchanged')) console.log(`💾 Caddy config: ${result}`);
  } catch (error: any) {
    console.error(`Could not snapshot Caddy on ${server.hostname}:`, error?.message);
  }
}

export async function pingServer(server: SshTarget & { name: string }): Promise<PingResult> {
  const startedAt = Date.now();

  try {
    await execRoot(server, ['true'], { timeout: PING_TIMEOUT_MS });
    await prisma.server.update({
      where: { id: server.id },
      data: { status: 'ONLINE', provisioned: true, lastSeenAt: new Date(), lastError: null },
    });

    void ensureSnapshot(server);
    void recordBeat({
      targetType: 'SERVER',
      targetId: server.id,
      ok: true,
      responseMs: Date.now() - startedAt,
    });
    return { id: server.id, name: server.name, status: 'ONLINE', provisioned: true };
  } catch (err: any) {
    // A RemoteExecError carrying an exit code means the command ran, so the
    // node answered — it is up, just not set up.
    if (err instanceof RemoteExecError && err.code !== null) {
      const note = `Reachable, but ${server.sshUser} cannot become root — use Set up server, log in as root, or grant sudo before placing organizations on it`;
      await prisma.server
        .update({
          where: { id: server.id },
          data: { status: 'ONLINE', provisioned: false, lastSeenAt: new Date(), lastError: note },
        })
        .catch(() => {});
      // Not provisioned by us, but reachable and quite possibly serving sites —
      // exactly the box whose Caddy config nothing else has a copy of.
      void ensureSnapshot(server);
      // reachable is up: not being set up by us is a configuration state, not an outage
      void recordBeat({
        targetType: 'SERVER',
        targetId: server.id,
        ok: true,
        responseMs: Date.now() - startedAt,
      });
      return { id: server.id, name: server.name, status: 'ONLINE', provisioned: false, error: note };
    }

    const error = explainSshFailure(server, String(err?.message || err)).slice(0, 500);
    // lastSeenAt is deliberately left alone: it means "last known good", and
    // how long a node has been down is the useful number.
    await prisma.server
      .update({ where: { id: server.id }, data: { status: 'OFFLINE', lastError: error } })
      .catch(() => {});
    void recordBeat({
      targetType: 'SERVER',
      targetId: server.id,
      ok: false,
      responseMs: Date.now() - startedAt,
      error,
    });
    return { id: server.id, name: server.name, status: 'OFFLINE', provisioned: false, error };
  }
}

export interface PingAllResult {
  total: number;
  online: number;
  offline: string[];
  results: PingResult[];
}

/** Check every node. Concurrent — one dead node must not delay the report on the others. */
export async function pingAllServers(): Promise<PingAllResult> {
  const servers = await prisma.server.findMany({
    select: {
      id: true,
      name: true,
      hostname: true,
      sshUser: true,
      sshPort: true,
      sshKeyPath: true,
      authMethod: true,
      sshPassword: true,
    },
  });

  const results = await Promise.all(servers.map(pingServer));
  return {
    total: results.length,
    online: results.filter((r) => r.status === 'ONLINE').length,
    offline: results.filter((r) => r.status !== 'ONLINE').map((r) => r.name),
    results,
  };
}
