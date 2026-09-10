import { prisma } from './prisma';
import type { SshTarget } from './runner';

/**
 * Which node an organization lives on.
 *
 * Placement is per organization, not per application: cb-provision-org creates
 * one OS user, one home and one cgroup slice per org, and every app of that
 * org lives inside that home. Splitting an org across nodes would mean
 * duplicating its user, so the org is the unit.
 */
export async function serverForOrg(slug: string): Promise<SshTarget> {
  const org = await prisma.organization.findUnique({
    where: { slug },
    select: { server: true },
  });

  if (!org) throw new Error(`Unknown organization: ${slug}`);
  // Refusing beats guessing. Picking a node for an unplaced org would create
  // the tenant's home on the wrong box, and the DNS record would point elsewhere.
  if (!org.server) {
    throw new Error(`Organization "${slug}" is not assigned to a server — assign one before provisioning`);
  }
  return org.server;
}

/**
 * Which node an application's routes and processes live on. Placement is per
 * organization, so this is `serverForOrg` reached through the app's owner —
 * kept here because most call sites have an application, not a slug.
 */
export async function serverForApplication(applicationId: string): Promise<SshTarget> {
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { domain: true, organization: { select: { slug: true, server: true } } },
  });

  if (!application) throw new Error(`Unknown application: ${applicationId}`);

  const server = application.organization?.server;
  if (!server) {
    throw new Error(
      `${application.domain} has no server — assign its organization to one before configuring routes`,
    );
  }
  return server;
}

/** Every node, for the jobs that have to visit all of them (route watchdog, snapshots). */
export async function allServers(): Promise<SshTarget[]> {
  return prisma.server.findMany({
    select: { id: true, hostname: true, sshUser: true, sshPort: true, sshKeyPath: true },
    orderBy: { createdAt: 'asc' },
  });
}
