/**
 * Provision (or repair) every organization on every node it uses: the nodes
 * its apps run on, plus any node it is already provisioned on. Waits for each
 * run and prints the outcome. Idempotent — the script re-applies ownership and
 * limits, so it doubles as a repair after a node is rebuilt.
 *
 *   npx tsx src/scripts/provisionOrgUsers.ts
 *   npx tsx src/scripts/provisionOrgUsers.ts --dry-run
 *
 * (The move from the pre-organization flat APPS_DIR used to live here too; it
 * only ever worked on a single box, and every install has long since run it.)
 */
import { prisma } from '../lib/prisma';
import { ORG_SLUG_RE } from '../lib/appPaths';
import { queueOrgNode, ensureOrgOnNode, OS_ISOLATION_ENABLED } from '../services/orgProvisionService';

const DRY = process.argv.includes('--dry-run');

async function main() {
  if (!OS_ISOLATION_ENABLED && !DRY) {
    console.error('ORG_OS_ISOLATION is not enabled — set it to "true" in the backend env first.');
    process.exit(1);
  }

  const orgs = await prisma.organization.findMany({
    select: {
      id: true,
      slug: true,
      applications: { where: { type: { not: 'STATIC' } }, select: { serverId: true } },
      nodes: { select: { serverId: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  const names = new Map((await prisma.server.findMany({ select: { id: true, name: true } })).map((s) => [s.id, s.name]));

  let done = 0;
  let failed = 0;
  for (const org of orgs) {
    if (!ORG_SLUG_RE.test(org.slug)) {
      console.error(`! org "${org.slug}" (${org.id}) has a slug no OS user can carry — rename it`);
      continue;
    }
    const serverIds = new Set([
      ...org.applications.map((a) => a.serverId).filter((id): id is string => !!id),
      ...org.nodes.map((n) => n.serverId),
    ]);
    if (serverIds.size === 0) continue;

    for (const serverId of serverIds) {
      const where = `cb-${org.slug} on ${names.get(serverId) ?? serverId}`;
      if (DRY) {
        console.log(`would provision ${where}`);
        continue;
      }
      try {
        await queueOrgNode(org.id, serverId, { trigger: 'script' });
        await ensureOrgOnNode(org.id, serverId, { trigger: 'script' });
        console.log(`ok     ${where}`);
        done++;
      } catch (err: any) {
        console.error(`FAILED ${where}: ${err?.message || err}`);
        failed++;
      }
    }
  }

  if (!DRY) console.log(`\n${done} provisioned, ${failed} failed`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
