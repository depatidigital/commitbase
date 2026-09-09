import { prisma } from '../lib/prisma';
import { exec, type SshTarget } from '../lib/runner';

/**
 * Node heartbeat.
 *
 * With one box, "is the server up?" answered itself — if it were down, nothing
 * would be asking. With several, a node can be unreachable for hours while the
 * panel serves happily, and the first sign would be a tenant's failed deploy.
 *
 * The check is deliberately the thing the control plane actually needs, not a
 * ping: it asks whether the provisioning script is present and executable over
 * the same SSH channel provisioning uses. That covers the whole chain in one
 * round trip — network, sshd, key authorization, and a correctly installed
 * node — so a green status means the next provision will work.
 */

const PROVISION_SCRIPT = process.env.ORG_PROVISION_SCRIPT || '/usr/local/bin/cb-provision-org';
const PING_TIMEOUT_MS = 10_000;

export type ServerStatus = 'ONLINE' | 'OFFLINE' | 'UNKNOWN';

export interface PingResult {
  id: string;
  name: string;
  status: ServerStatus;
  error?: string;
}

/** Check one node and record the verdict. Never throws — an unreachable node is data, not an exception. */
export async function pingServer(server: SshTarget & { name: string }): Promise<PingResult> {
  try {
    await exec(server, ['test', '-x', PROVISION_SCRIPT], { timeout: PING_TIMEOUT_MS });
    await prisma.server.update({
      where: { id: server.id },
      data: { status: 'ONLINE', lastSeenAt: new Date(), lastError: null },
    });
    return { id: server.id, name: server.name, status: 'ONLINE' };
  } catch (err: any) {
    const error = String(err?.message || err).slice(0, 500);
    // lastSeenAt is deliberately left alone: it means "last known good", and
    // how long a node has been down is the useful number.
    await prisma.server
      .update({ where: { id: server.id }, data: { status: 'OFFLINE', lastError: error } })
      .catch(() => {});
    return { id: server.id, name: server.name, status: 'OFFLINE', error };
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
    select: { id: true, name: true, hostname: true, sshUser: true, sshPort: true, sshKeyPath: true },
  });

  const results = await Promise.all(servers.map(pingServer));
  return {
    total: results.length,
    online: results.filter((r) => r.status === 'ONLINE').length,
    offline: results.filter((r) => r.status !== 'ONLINE').map((r) => r.name),
    results,
  };
}
