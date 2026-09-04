/**
 * Provision (or repair) the OS user, home, quota, cgroup slice and PHP-FPM pool
 * for every organization, then move any application directory still sitting in
 * the old flat APPS_DIR into its organization's home.
 *
 * Idempotent. Run as a user that can sudo the provisioning scripts.
 *
 *   npx tsx src/scripts/provisionOrgUsers.ts          # provision + migrate
 *   npx tsx src/scripts/provisionOrgUsers.ts --dry-run
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { prisma } from '../lib/prisma';
import { appDirFor, ORG_SLUG_RE } from '../lib/appPaths';
import { provisionOrg, OS_ISOLATION_ENABLED } from '../services/orgProvisionService';

const DRY = process.argv.includes('--dry-run');
const LEGACY_APPS_DIR = process.env.APPS_DIR || path.join(process.cwd(), 'apps_dir');

const exists = (p: string) => fs.access(p).then(() => true).catch(() => false);

async function main() {
  if (!OS_ISOLATION_ENABLED && !DRY) {
    console.error('ORG_OS_ISOLATION is not enabled — set it to "true" in the backend env first.');
    process.exit(1);
  }

  const orgs = await prisma.organization.findMany({
    include: { applications: { select: { id: true, domain: true } } },
    orderBy: { createdAt: 'asc' },
  });

  let moved = 0;
  let skipped = 0;

  for (const org of orgs) {
    if (!ORG_SLUG_RE.test(org.slug)) {
      console.error(`! org "${org.slug}" (${org.id}) has a slug no OS user can carry — rename it`);
      skipped++;
      continue;
    }

    console.log(`\n== ${org.slug} (${org.applications.length} apps)`);
    if (DRY) {
      console.log(`   would provision cb-${org.slug}`);
    } else {
      const result = await provisionOrg(org.slug);
      console.log(`   ${result.output?.split('\n').join('\n   ')}`);
    }

    for (const app of org.applications) {
      const target = appDirFor(app.id, org.slug);
      if (await exists(target)) continue;

      // The old layout keyed on the id; a few log helpers keyed on the domain,
      // so check both before giving up.
      const candidates = [path.join(LEGACY_APPS_DIR, app.id), path.join(LEGACY_APPS_DIR, app.domain)];
      const source = (await Promise.all(candidates.map(async (c) => ((await exists(c)) ? c : null)))).find(Boolean);

      if (!source) {
        console.log(`   - ${app.domain}: no existing directory, will be created on next deploy`);
        continue;
      }

      console.log(`   ${DRY ? 'would move' : 'moving'} ${source} -> ${target}`);
      if (!DRY) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rename(source, target).catch(async (err: NodeJS.ErrnoException) => {
          if (err.code !== 'EXDEV') throw err;
          // Different filesystem: copy then drop the original.
          await fs.cp(source, target, { recursive: true });
          await fs.rm(source, { recursive: true, force: true });
        });
      }
      moved++;
    }

    // Re-run so the moved files end up owned by the tenant user.
    if (!DRY) await provisionOrg(org.slug);
  }

  const orphans = await prisma.application.count({ where: { organizationId: null } });
  console.log(`\nmoved ${moved} app directories, ${skipped} orgs skipped`);
  if (orphans) {
    console.log(`${orphans} applications have no organization — they stay in ${LEGACY_APPS_DIR} until assigned`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
