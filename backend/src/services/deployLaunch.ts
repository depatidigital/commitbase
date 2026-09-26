import { AppStatus, Application, Deployment } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { readEnv } from '../lib/appEnv';
import { DeploymentService } from './deployment';
import { ensureAppHostname } from './appDnsService';
import { measureAppDisk } from './appDiskService';
import { provisionInBackground } from './sslProvisionService';
import { serverForApplication } from '../lib/servers';
import { draining, DRAINED_FILE } from '../lib/drain';
import { pm2Busy } from './pm2DeployService';
import { existsSync } from 'fs';
import { rm, writeFile } from 'fs/promises';

const deploymentService = new DeploymentService();

type LaunchOptions = { resolveMigration?: string; resolveAs?: 'rolled-back' | 'applied'; resetDatabase?: boolean; skipPreDeploy?: boolean; acceptDataLoss?: boolean };

/**
 * Start a deploy of `application` in the background, and return its row. null
 * when one is already running. A project deploy is each of its apps launched
 * (routes/sources.ts). The caller has checked the app may be deployed
 * (panel-managed, in scope).
 */
export async function launchDeploy(
  application: Application,
  userId: string,
  /** resolveMigration: a Prisma migration recorded as failed, cleared before this deploy's migrations */
  options: LaunchOptions = {},
): Promise<{ deploymentId: string } | null> {
  // A running app can be redeployed — the new release builds beside it and
  // takes over only once it answers. Two deploys at once is the thing to stop.
  const group = await deploymentService.groupOf(application);
  if (
    group.some((app) => app.status === 'DEPLOYING' || app.status === 'BUILDING') ||
    deploymentService.isDeploying(application)
  ) {
    return null;
  }

  // Create deployment record — with its options, so a restart can start it again
  const deployment = await prisma.deployment.create({
    data: {
      status: 'PENDING',
      applicationId: application.id,
      sourceId: application.sourceId,
      userId: userId,
      options,
    },
  });
  if (draining()) {
    // queued for after the upgrade: "deploying" meanwhile, so a second click is refused
    await Promise.all(group.map((app) => prisma.application.update({ where: { id: app.id }, data: { status: 'DEPLOYING' } })));
    await prisma.deployment.update({ where: { id: deployment.id }, data: { deployLogs: QUEUED_NOTE } });
    return { deploymentId: deployment.id };
  }
  // awaits DNS only; the build goes on in the background
  await run(application, group, deployment, userId, options);
  return { deploymentId: deployment.id };
}

/**
 * Deploys queued (PENDING) when the panel stopped — a restart, a crash, an
 * upgrade: started again, oldest first, as they were asked for. Panel-managed
 * apps only; an imported app's build is recoverPm2Deploys'. Called at startup.
 */
export async function resumeQueuedDeploys(): Promise<number> {
  const queued = await prisma.deployment.findMany({
    where: { status: 'PENDING', application: { runtime: null } },
    include: { application: true },
    orderBy: { createdAt: 'asc' },
  });
  let started = 0;
  for (const row of queued) {
    // still waiting in this process (a drain given up): it starts on its own
    if (deploymentService.isDeploying(row.application)) continue;
    started += 1;
    const group = await deploymentService.groupOf(row.application);
    // what each app was before it queued: the status says DEPLOYING now, so from what is live
    await Promise.all(
      group.map((app) =>
        prisma.application.update({ where: { id: app.id }, data: { status: app.activeReleaseId ? 'RUNNING' : 'STOPPED' } }),
      ),
    );
    const fresh = await deploymentService.groupOf(row.application);
    await prisma.deployment.update({
      where: { id: row.id },
      data: { deployLogs: `${row.deployLogs ?? ''}Queued while the panel restarted or updated — started again.\n` },
    });
    await run(row.application, fresh, row, row.userId, (row.options ?? {}) as LaunchOptions);
  }
  return started;
}

const QUEUED_NOTE = 'Queued — Larika is updating. It starts once the update is done.\n';

/**
 * Follow the upgrade drain (lib/drain.ts): once nothing is deploying, say so
 * with DRAINED_FILE for larika-upgrade.sh; when the drain is lifted without a
 * restart (the script gave up waiting), start what queued meanwhile.
 */
export function watchDrain(): void {
  let was = false;
  setInterval(() => {
    const now = draining();
    if (now && deploymentService.busy() === 0 && pm2Busy() === 0 && !existsSync(DRAINED_FILE)) {
      writeFile(DRAINED_FILE, `${new Date().toISOString()}\n`).catch((err) => console.error('Could not write the drain file:', err));
    }
    if (!now && was) {
      void rm(DRAINED_FILE, { force: true }).catch(() => {});
      resumeQueuedDeploys().catch((err) => console.error('Could not resume queued deploys:', err));
    }
    was = now;
  }, 2000).unref();
}

/**
 * The deploy behind a PENDING row: DNS awaited, then the build, switch, and the
 * row and statuses after it in the background.
 */
async function run(
  application: Application,
  group: Application[],
  deployment: Deployment,
  userId: string,
  { resolveMigration, resolveAs, resetDatabase, skipPreDeploy, acceptDataLoss }: LaunchOptions,
): Promise<void> {
  // the app keeps its own status, from what it was before
  const scoped = group;
  const before = new Map(scoped.map((app) => [app.id, app.status]));
  const setStatus = (status: (was: AppStatus) => AppStatus, extra: { lastDeployment?: Date } = {}) =>
    Promise.all(
      [...before].map(([appId, was]) => prisma.application.update({ where: { id: appId }, data: { status: status(was), ...extra } })),
    );

  // Update application status
  await setStatus(() => 'DEPLOYING');

  // Heal the DNS records before the build runs — someone may have removed one,
  // and a deploy that finishes into a hostname that does not resolve is worse
  // than one that says so.
  let dnsWarning = '';
  // every name of every app this deploy covers
  const names = await prisma.appDomain.findMany({
    where: { applicationId: { in: scoped.map((app) => app.id) } },
    select: { applicationId: true, host: true, domainId: true },
    orderBy: { host: 'asc' },
  });
  for (const name of names) {
    // bounded: the row already says "deploying", and until deploy() below runs
    // nothing can cancel it — a hung DNS API must not hold the app there
    const dns = await Promise.race([
      ensureAppHostname({ id: name.applicationId, domain: name.host, domainId: name.domainId }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('DNS API did not answer in 30s')), 30_000).unref()),
    ]).catch((error: any) => ({ state: 'unavailable' as const, detail: String(error?.message ?? 'DNS setup failed') }));
    // does not fail the deploy — the hostname may be in a zone we do not run
    if (dns.state === 'conflict' || dns.state === 'unavailable') {
      dnsWarning += `DNS was not set up${names.length > 1 ? ` for ${name.host}` : ''}: ${dns.detail}\n\n`;
    }
  }

  // Start deployment in background
  deploymentService.deploy({
    application,
    deployment,
    envVars: readEnv(application.envVars),
    ...(resolveMigration && { resolveMigration }),
    ...(resolveAs && { resolveAs }),
    ...(resetDatabase && { resetDatabase }),
    ...(skipPreDeploy && { skipPreDeploy }),
    ...(acceptDataLoss && { acceptDataLoss }),
  }).then(async (result) => {
    // queued by an upgrade drain before it built: the row stays PENDING, the app "deploying"
    if (result.queued) {
      await prisma.deployment.update({ where: { id: deployment.id }, data: { deployLogs: QUEUED_NOTE } });
      return;
    }
    // cancelled: the service already wrote CANCELLED and why; and whatever
    // ran before still runs — back to that, or stopped if nothing did
    if (result.cancelled) {
      await setStatus((was) => (was === 'RUNNING' ? 'RUNNING' : 'STOPPED'));
      return;
    }

    // Update deployment record with logs. A deploy that threw returns only
    // `error` — keep the build log it already wrote to the row, and say why.
    await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status: result.success ? 'SUCCESS' : 'FAILED',
        ...(result.buildLogs !== undefined && { buildLogs: result.buildLogs }),
        deployLogs: dnsWarning + (result.deployLogs || (result.success ? '' : result.error || 'Deployment failed')),
      },
    });

    // Only the switch to the new release can take the site down, and it says
    // how that went (rolledBack). A deploy that failed before it — build,
    // sync, anything thrown early — never touched what was running.
    const touched = result.rolledBack !== undefined;
    await setStatus(
      (was) => (result.success || result.rolledBack || (!touched && was === 'RUNNING') ? 'RUNNING' : 'ERROR'),
      // only a deploy that left something running counts — the UI reads
      // lastDeployment as "has a build to start"
      result.success ? { lastDeployment: new Date() } : {},
    );
    // what the deploy left on disk, for the project list; a miss waits for the cron
    void measureAppDisk(application.id).catch(() => {});
    // its hosts get a certificate on the node — through Cloudflare's proxy too
    // (proxy off, Caddy reloaded, proxy back on). A host that has one already is
    // skipped, so a redeploy costs a check, not a reload.
    if (result.success && names.length) {
      void serverForApplication(application.id)
        .then((node) => provisionInBackground(node, names.map((name) => name.host), userId))
        .catch(() => {});
    }
  }).catch(async (error) => {
    console.error('Deployment failed:', error);

    // Update deployment record
    await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status: 'FAILED',
        buildLogs: error.message || 'Deployment failed',
      },
    });

    // thrown before anything was switched: what ran before still runs
    await setStatus((was) => (was === 'RUNNING' ? 'RUNNING' : 'ERROR'));
  });
}
