import { PrismaClient } from '@prisma/client';
import { candidateParents } from '../lib/scope';

const prisma = new PrismaClient();

const slugify = (v: string) =>
  v.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'org';

/**
 * One-shot migration to the organization model. Idempotent — safe to re-run.
 *
 *   1. every existing user gets a personal organization (they become OWNER)
 *   2. their domains and applications move to that organization
 *   3. each application is linked to the Domain row its hostname lives under
 *
 * Run after `npm run db:push`.
 */
async function main() {
  console.log('🔄 Backfilling organizations ...');

  const users = await prisma.user.findMany({ include: { memberships: true } });

  for (const user of users) {
    let organizationId = user.memberships[0]?.organizationId;

    if (!organizationId) {
      const base = slugify(user.name || user.email.split('@')[0] || 'org');
      let slug = base;
      let n = 1;
      while (await prisma.organization.findUnique({ where: { slug } })) {
        slug = `${base}-${n++}`;
      }

      const org = await prisma.organization.create({
        data: {
          name: user.name || user.email,
          slug,
          members: { create: { userId: user.id, role: 'OWNER' } },
        },
      });
      organizationId = org.id;
      console.log(`  + org "${org.slug}" for ${user.email}`);
    }

    const [domains, apps] = await Promise.all([
      prisma.domain.updateMany({
        where: { userId: user.id, organizationId: null },
        data: { organizationId },
      }),
      prisma.application.updateMany({
        where: { userId: user.id, organizationId: null },
        data: { organizationId },
      }),
    ]);

    if (domains.count || apps.count) {
      console.log(`    moved ${domains.count} domain(s), ${apps.count} application(s)`);
    }
  }

  // link each application to its parent domain
  console.log('🔄 Linking applications to their parent domain ...');

  const domainRows = await prisma.domain.findMany({ select: { id: true, name: true } });
  const byName = new Map(domainRows.map((d) => [d.name.toLowerCase(), d]));

  const unlinked = await prisma.application.findMany({
    where: { domainId: null },
    select: { id: true, domain: true },
  });

  const orphans: string[] = [];

  for (const app of unlinked) {
    const parent = candidateParents(app.domain)
      .map((n) => byName.get(n))
      .find(Boolean);

    if (!parent) {
      orphans.push(app.domain);
      continue;
    }

    await prisma.application.update({ where: { id: app.id }, data: { domainId: parent.id } });
  }

  console.log(`✅ Linked ${unlinked.length - orphans.length} application(s).`);

  if (orphans.length) {
    console.log(`⚠️  ${orphans.length} application(s) have no matching Domain row:`);
    orphans.forEach((d) => console.log(`   - ${d}`));
    console.log('   Create those Domain rows (POST /api/domains) and re-run, or the owners cannot edit them.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
