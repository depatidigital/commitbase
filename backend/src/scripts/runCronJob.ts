/**
 * Run a scheduled job by hand, without waiting for its cron tick.
 *
 *   npm run cron:run domain-sync
 */
import { runJobNow } from '../services/cron';
import { prisma } from '../lib/prisma';

const name = process.argv[2];

if (!name) {
  console.error('Usage: npm run cron:run <job-name>   (e.g. domain-sync)');
  process.exit(1);
}

runJobNow(name)
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
