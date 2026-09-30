import { prisma } from './prisma';
import { isIP } from 'net';
import { exec, type SshTarget } from './runner';
import { syncNodeAllowlist } from '../services/cloudflareService';

/**
 * Which node an application runs on.
 *
 * Placement is per application: an organization can span nodes, and is
 * provisioned (OS user, home, slice, FPM pool) on each node it uses — see
 * OrgNode and orgProvisionService. The org's default server only fills in for
 * an app that has none recorded.
 *
 * Refusing beats guessing: an app with no node would be built on the wrong box
 * and its DNS record would point elsewhere.
 */
export async function serverForApplication(applicationId: string): Promise<SshTarget & { id: string; publicIp: string }> {
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { name: true, server: true, organization: { select: { defaultServer: true } } },
  });

  if (!application) throw new Error(`Unknown application: ${applicationId}`);

  const server = application.server ?? application.organization?.defaultServer;
  if (!server) {
    throw new Error(`${application.name} has no server — pick one for the app, or set its organization's default server`);
  }
  return server;
}

/** Every node, for the jobs that have to visit all of them (route watchdog, snapshots). */
export async function allServers(): Promise<SshTarget[]> {
  return prisma.server.findMany({
    select: {
      id: true,
      hostname: true,
      sshUser: true,
      sshPort: true,
      sshKeyPath: true,
      authMethod: true,
      sshPassword: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Apps that run on a node: placed there, or — with no node of their own — in
 * an organization whose default server it is.
 */
export const appsOnServer = (serverId: string) => ({
  OR: [{ serverId }, { serverId: null, organization: { defaultServerId: serverId } }],
});

// both families: a node with IPv6 usually reaches Cloudflare over it, not its IPv4
const EGRESS_PROBE =
  'for f in -4 -6; do curl -s $f --max-time 5 https://www.cloudflare.com/cdn-cgi/trace | grep ^ip=; done; true';

/** The addresses Cloudflare sees when this node calls out — null when it could not be asked. */
async function egressIps(server: SshTarget): Promise<string[] | null> {
  try {
    const { stdout } = await exec(server, ['sh', '-c', EGRESS_PROBE], { timeout: 20_000 });
    return stdout.split('\n').map((line) => line.replace(/^ip=/, '').trim()).filter((ip) => isIP(ip));
  } catch {
    return null;
  }
}

/**
 * Push every node's addresses to Cloudflare's allowlist: its publicIp plus what
 * it actually leaves the box as (IPv6, NAT). Call after nodes change.
 */
export async function syncNodeIpsToCloudflare(): Promise<void> {
  const servers = await prisma.server.findMany({
    select: { id: true, hostname: true, sshUser: true, sshPort: true, sshKeyPath: true, authMethod: true, sshPassword: true, publicIp: true },
  });
  const probed = await Promise.all(servers.map(egressIps));
  const ips = servers.flatMap((s, i) => [s.publicIp.trim(), ...(probed[i] ?? [])]).filter((ip) => isIP(ip));
  // a node we could not reach may still own rules from an earlier probe: keep them
  await syncNodeAllowlist([...new Set(ips)], { prune: probed.every(Boolean) });
}
