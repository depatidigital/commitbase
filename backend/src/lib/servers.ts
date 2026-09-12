import { prisma } from './prisma';
import type { SshTarget } from './runner';

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
    select: { domain: true, server: true, organization: { select: { defaultServer: true } } },
  });

  if (!application) throw new Error(`Unknown application: ${applicationId}`);

  const server = application.server ?? application.organization?.defaultServer;
  if (!server) {
    throw new Error(`${application.domain} has no server — pick one for the app, or set its organization's default server`);
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
