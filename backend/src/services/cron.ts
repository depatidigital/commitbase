import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { syncDomains } from './domainSyncService';

/**
 * Internal scheduler for integration sync jobs.
 *
 * One place to register anything that has to run on a clock. Jobs are
 * best-effort: a failure is logged and the next tick tries again.
 *
 * ponytail: in-process cron, so it fires once per running instance. Move to a
 * DB advisory lock or an external scheduler if the backend is ever run with
 * more than one replica.
 */

type Job = {
  name: string;
  /** cron expression, overridable per job via env */
  schedule: string;
  run: () => Promise<string>;
};

/** Rows created by a scheduled sync need an owner — use the platform account. */
async function systemUserId(): Promise<string | null> {
  const user = await prisma.user.findFirst({
    where: { role: { in: ['SUPERADMIN', 'ADMIN'] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return user?.id ?? null;
}

const jobs: Job[] = [
  {
    name: 'domain-sync',
    // every day at 03:00 server time
    schedule: process.env.CRON_DOMAIN_SYNC || '0 3 * * *',
    run: async () => {
      const userId = await systemUserId();
      if (!userId) return 'skipped — no admin account to own new rows';

      const r = await syncDomains(userId);
      const failed = r.errors ? ` (errors: ${Object.keys(r.errors).join(', ')})` : '';
      return `${r.total} domains, ${r.created} added, ${r.updated} updated${failed}`;
    },
  },
];

/** Jobs already running, so a slow run is never overlapped by the next tick. */
const running = new Set<string>();

async function runJob(job: Job) {
  if (running.has(job.name)) {
    console.warn(`⏭️  cron ${job.name}: previous run still going, skipping this tick`);
    return;
  }

  running.add(job.name);
  const startedAt = Date.now();
  try {
    const summary = await job.run();
    console.log(`✅ cron ${job.name}: ${summary} (${Date.now() - startedAt}ms)`);
  } catch (error) {
    console.error(`❌ cron ${job.name} failed:`, error);
  } finally {
    running.delete(job.name);
  }
}

export function startCronJobs() {
  // CRON_ENABLED=false turns the scheduler off (local dev, one-off containers)
  if (process.env.CRON_ENABLED === 'false') {
    console.log('⏸️  Cron jobs disabled (CRON_ENABLED=false)');
    return;
  }

  for (const job of jobs) {
    if (!cron.validate(job.schedule)) {
      console.error(`❌ cron ${job.name}: invalid schedule "${job.schedule}", job not registered`);
      continue;
    }
    cron.schedule(job.schedule, () => void runJob(job), { timezone: process.env.TZ || 'UTC' });
    console.log(`⏰ cron ${job.name} scheduled: ${job.schedule}`);
  }
}

/** Run one job by name, now — for an admin "run it now" action or a manual script. */
export async function runJobNow(name: string) {
  const job = jobs.find((j) => j.name === name);
  if (!job) throw new Error(`Unknown cron job: ${name}`);
  await runJob(job);
}
