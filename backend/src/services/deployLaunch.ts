import { AppStatus, Application } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { readEnv } from '../lib/appEnv';
import { DeploymentService } from './deployment';
import { ensureAppHostname } from './appDnsService';

const deploymentService = new DeploymentService();

/**
 * Start a deploy of `application` in the background, and return its row. null
 * when one is already running. A project deploy is each of its apps launched
 * (routes/sources.ts). The caller has checked the app may be deployed
 * (panel-managed, in scope).
 */
export async function launchDeploy(application: Application, userId: string): Promise<{ deploymentId: string } | null> {
  // the app keeps its own status, from what it was before
  const group = await deploymentService.groupOf(application);
  const scoped = group;
  const before = new Map(scoped.map((app) => [app.id, app.status]));
  const setStatus = (status: (was: AppStatus) => AppStatus, extra: { lastDeployment?: Date } = {}) =>
    Promise.all(
      [...before].map(([appId, was]) => prisma.application.update({ where: { id: appId }, data: { status: status(was), ...extra } })),
    );

  // A running app can be redeployed — the new release builds beside it and
  // takes over only once it answers. Two deploys at once is the thing to stop.
  if (
    group.some((app) => app.status === 'DEPLOYING' || app.status === 'BUILDING') ||
    deploymentService.isDeploying(application)
  ) {
    return null;
  }

  // Create deployment record
  const deployment = await prisma.deployment.create({
    data: {
      status: 'PENDING',
      applicationId: application.id,
      sourceId: application.sourceId,
      userId: userId,
    },
  });

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
    const dns = await ensureAppHostname({ id: name.applicationId, domain: name.host, domainId: name.domainId }).catch(
      (error: any) => ({ state: 'unavailable' as const, detail: String(error?.message ?? 'DNS setup failed') }),
    );
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
  }).then(async (result) => {
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

  return { deploymentId: deployment.id };
}
