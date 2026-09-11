import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { syncDomains, backfillExpiries } from './domainSyncService';
import { provisionPending } from './domainProvisionService';
import { healCaddyRoutes } from './caddySnapshotService';
import { syncServerApps } from './appSyncService';
import { pruneHeartbeats, checkApplicationHostnames } from './heartbeatService';
import { pingAllServers } from './serverHealthService';
import { checkAllDatabaseServers } from './databaseServerService';
import { provisionQueuedOrgs } from './orgProvisionService';
import { setupQueuedServers } from './serverSetupService';

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
    name: 'server-health',
    // Every five minutes. Often enough that an admin looking at the servers
    // list sees the truth, rare enough to be invisible against a deploy.
    schedule: process.env.CRON_SERVER_HEALTH || '*/5 * * * *',
    run: async () => {
      const r = await pingAllServers();
      // database servers ride along: most tunnel through the nodes just pinged
      const d = await checkAllDatabaseServers();
      const offline = [...r.offline, ...d.offline];
      return `${r.online}/${r.total} node(s), ${d.online}/${d.total} database server(s) online${offline.length ? ` — offline: ${offline.join(', ')}` : ''}`;
    },
  },
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
  {
    name: 'app-inventory',
    // Imported apps are not supervised by us, so the status watcher skips them —
    // their pm2 state and listening ports are only as fresh as the last scan.
    // Ten minutes: two cheap SSH commands per node, on a pooled connection.
    schedule: process.env.CRON_APP_INVENTORY || '*/10 * * * *',
    run: async () => {
      const userId = await systemUserId();
      if (!userId) return 'skipped — no admin account to own new rows';

      const r = await syncServerApps(userId);
      const failed = r.errors?.length ? ` (errors: ${r.errors.length})` : '';
      return `${r.discovered} site(s), ${r.created} added, ${r.updated} updated${failed}`;
    },
  },
  {
    name: 'app-http-check',
    // Every minute. No SSH — a TLS connection from the control plane — so it is
    // cheap enough to give the heartbeat bars a minute of resolution, and an
    // outage is called within two checks instead of twenty minutes.
    schedule: process.env.CRON_APP_HTTP_CHECK || '* * * * *',
    run: checkApplicationHostnames,
  },
  {
    name: 'heartbeat-prune',
    // Beats are written by every check; nothing asks about them past a month.
    schedule: process.env.CRON_HEARTBEAT_PRUNE || '30 4 * * *',
    run: async () => `${await pruneHeartbeats()} beat(s) pruned`,
  },
  {
    name: 'caddy-routes',
    // Caddy keeps the API config in memory and there are no site files left to
    // rebuild it from. Snapshot it while it is healthy, push the snapshot back
    // when a reload has thrown the routes away.
    schedule: process.env.CRON_CADDY_ROUTES || '*/5 * * * *',
    run: healCaddyRoutes,
  },
  {
    name: 'domain-expiry',
    // Domains with no expiry on record — a fresh registration the registrar has
    // not listed yet, or a TLD RDAP stays quiet about. Daily, an hour after the
    // full sync has had its go at them.
    schedule: process.env.CRON_DOMAIN_EXPIRY || '0 4 * * *',
    run: backfillExpiries,
  },
  {
    name: 'domain-provision',
    // Registrations are kicked off in-process the moment they are queued; this
    // only catches what a restart or a failed DNS step left half-done.
    schedule: process.env.CRON_DOMAIN_PROVISION || '* * * * *',
    run: provisionPending,
  },
  {
    name: 'org-provision',
    // Queued orgs are kicked in-process; this catches restarts and orgs that
    // were queued before they had a server.
    schedule: process.env.CRON_ORG_PROVISION || '* * * * *',
    run: provisionQueuedOrgs,
  },
  {
    name: 'server-setup',
    // Same shape: kicked in-process, swept for what a restart cut short.
    schedule: process.env.CRON_SERVER_SETUP || '* * * * *',
    run: setupQueuedServers,
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
