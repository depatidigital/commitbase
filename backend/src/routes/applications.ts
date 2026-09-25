import { Router, Request, Response } from 'express';
import { AppType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { CreateApplicationSchema, UpdateApplicationSchema, ApiResponse, Application, PaginatedResponse } from '../types';
import { validateRequest } from '../middleware/validation';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { paging, contains } from '../lib/paging';
import { appScope, canManageOrg, canManageProject, getOrgIds, isPlatformAdmin, listMemberships, projectScope } from '../lib/scope';
import { applyAppDns, inspectHost, normalizeHost, resolveAppHost, sharedHostTaken } from '../lib/appHostname';
import { appHosts, appIdAt, atEach, hostList, hostRefused, hostsOf, setAppHosts, withDomains } from '../lib/appDomains';
import { DeploymentService } from '../services/deployment';
import { uploadSiteObject, deleteSiteObjects, copySiteObjects } from '../services/r2Service';
import {
  adoptRootFiles,
  deleteAllSiteFiles,
  discardFolder,
  inFolder,
  listReleaseFiles,
  pruneStaticReleases,
  releaseFolder,
  servingFolder,
  siteRootOrigin,
  siteStorage,
} from '../services/staticReleaseService';
import { Pm2DeployError, startPm2Deploy } from '../services/pm2DeployService';
import { addCaddyHost, staticRouteError } from '../services/caddyService';
import { hostsOnlyOf, normalizeBindingPath, readServe, recomposeHosts, serveApp, serveStatic } from '../services/hostRouteService';
import { appDiskUsage, cleanupApp, measureAppDisk } from '../services/appDiskService';
import { ensureAppHostname, removeAppHostname, checkAppHostname, dnsManaged, healthPath, whereHostnamePoints } from '../services/appDnsService';
import { serverForApplication } from '../lib/servers';
import { provisionInBackground } from '../services/sslProvisionService';
import { forgetPointing, healthFor, isServing } from '../services/heartbeatService';
import * as systemd from '../services/systemdService';
import * as compose from '../services/composeService';
import { appFsFor, sourceFsFor } from '../lib/appFs';
import { cleanRootDirectory, inRootDirectory, ROOT_DIRECTORY_RE } from '../lib/appPaths';
import { ensureOrgOnNode, queueOrgNode } from '../services/orgProvisionService';
import { detectAppsFromRepo, detectFromFiles, detectFromRepo,detectProject, isEnvFile, listRemoteBranches, parseEnvFile, parseLsRemote, presenceOnly, DETECT_FILES, DetectInput } from '../lib/projectDetect';
import { exec } from '../lib/runner';
import { gitAuthFor, providerOf } from '../lib/gitCredentials';
import { getGitOAuthConfig } from '../services/integrationConfigService';
import { readEnv, readEnvFiles, sealEnv, sealEnvFiles } from '../lib/appEnv';
import { createApplicationWithSource, dropOrphanSources, setSourceOrganization, sourceName, withSourceFields } from '../lib/sources';
import { launchDeploy } from '../services/deployLaunch';
import { syncServerApps, scanServerApps, controlPm2Process } from '../services/appSyncService';
import { healCaddyRoutes, snapshotCaddyConfig, restoreCaddyConfig } from '../services/caddySnapshotService';
import { requireRole } from '../middleware/auth';
import { folderExists, teardownApp, teardownPlan } from '../services/appTeardownService';
import { hostnameRegistration } from '../services/rdapService';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';

const router: Router = Router();
const deploymentService = new DeploymentService();

/**
 * List order for ?sort=&order=. Unsorted, what needs attention leads: AppStatus
 * is declared RUNNING, STOPPED, ERROR, DEPLOYING, BUILDING, so descending puts
 * work in flight and broken apps above the healthy ones. Name breaks every tie
 * so a page never reshuffles between refetches.
 */
const sortOrder = (sort: unknown, order: unknown): any[] => {
  const direction = order === 'desc' ? 'desc' : 'asc';
  const byName = { name: 'asc' as const };

  switch (sort) {
    case 'name':
      return [{ name: direction }];
    case 'status':
      return [{ status: direction }, byName];
    case 'type':
      return [{ type: direction }, byName];
    case 'organization':
      return [{ organization: { name: direction } }, byName];
    case 'server':
      return [{ server: { name: direction } }, byName];
    case 'createdAt':
      // a sync creates a batch within the same moment
      return [{ createdAt: direction }, byName];
    default:
      // switched-off apps go last, whatever state they were left in
      return [{ disabled: 'asc' }, { status: 'desc' }, byName];
  }
};

/**
 * Apps imported by the server sync (runtime set) were set up by hand and run
 * under their own users, dirs and supervisor — the panel watches them, it does
 * not manage them. Deploying one would build a second, managed copy beside it
 * and take over its Caddy route; provisioning is only for apps created here.
 */
function refuseImported(application: { runtime: string | null }, res: Response): Response | null {
  if (!application.runtime) return null;
  return res.status(409).json({
    success: false,
    error: `This app was imported from its server (${application.runtime}) and is managed there, not by the panel. Deploys and releases are for apps created in the panel.`,
  } as ApiResponse);
}

/**
 * Imported pm2 apps: start/stop/restart go to pm2 on their node. Other imported
 * apps are refused (see refuseImported). Returns null for apps the panel
 * manages, and the caller falls through to systemd.
 */
async function handlePm2Action(
  application: { id: string; runtime: string | null; processName: string | null; serverId: string | null },
  action: 'start' | 'stop' | 'restart',
  res: Response
): Promise<Response | null> {
  if (application.runtime !== 'PM2' || !application.processName) {
    return refuseImported(application, res);
  }

  // pm2 runs on the node the sync found the process on, not on the control plane
  const server = application.serverId
    ? await prisma.server.findUnique({ where: { id: application.serverId } })
    : null;
  if (!server) {
    return res.status(409).json({ success: false, error: 'This pm2 app is not linked to a server — re-sync it' } as ApiResponse);
  }

  const result = await controlPm2Process(server, application.processName, action);

  if (!result.success) {
    await prisma.application.update({ where: { id: application.id }, data: { status: 'ERROR' } });
    return res.status(500).json({ success: false, error: result.output } as ApiResponse);
  }

  await prisma.application.update({
    where: { id: application.id },
    data: { status: action === 'stop' ? 'STOPPED' : 'RUNNING' },
  });

  return res.json({
    success: true,
    data: { runtime: 'PM2', processName: application.processName },
    message: `pm2 ${action} succeeded`,
  } as ApiResponse);
}

/**
 * The git account may only be one the caller connected themselves. Without this
 * check an application could be pointed at somebody else's OAuth token and
 * deploy from their private repositories.
 */
async function assertOwnGitAccount(
  gitAccountId: string | null | undefined,
  userId: string,
  res: Response
): Promise<boolean> {
  if (!gitAccountId) return true;

  const account = await prisma.gitAccount.findFirst({ where: { id: gitAccountId, userId } });
  if (!account) {
    res.status(403).json({ success: false, error: 'Unknown git account' } as ApiResponse);
    return false;
  }
  return true;
}

// Preview what is running on the server without touching the database
router.get('/scan', authenticateToken, requireRole(['SUPERADMIN']), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const apps = await scanServerApps();
    return res.json({ success: true, data: apps, message: `${apps.length} apps found on the server` } as ApiResponse);
  } catch (error) {
    console.error('Error scanning server apps:', error);
    return res.status(500).json({ success: false, error: 'Failed to scan server apps' } as ApiResponse);
  }
});

// Import/refresh the server inventory (pm2 processes + Caddy sites)
router.post('/sync', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await syncServerApps(req.user!.userId);
    return res.json({
      success: true,
      data: result,
      message: `${result.created} imported, ${result.updated} updated`,
    } as ApiResponse);
  } catch (error) {
    console.error('Error syncing server apps:', error);
    return res.status(500).json({ success: false, error: 'Failed to sync server apps' } as ApiResponse);
  }
});

// Get all applications for the authenticated user
// Framework detection for the "new app" form. Either the files the browser
// already read (upload flow) or a repository URL (git flow — shallow clone of
// the detection files only).
/** Store the live Caddy config now, rather than waiting for the watchdog tick. */
router.post('/caddy/snapshot', authenticateToken, requireRole(['SUPERADMIN']), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json({ success: true, message: await snapshotCaddyConfig() } as ApiResponse);
  } catch (error: any) {
    console.error('Error snapshotting Caddy config:', error);
    return res.status(502).json({
      success: false,
      error: error?.message || 'Could not read the Caddy config',
    } as ApiResponse);
  }
});

/** Push the newest snapshot back — for a reload that took the routes with it. */
router.post('/caddy/restore', authenticateToken, requireRole(['SUPERADMIN']), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await restoreCaddyConfig();

    return res.json({
      success: result.restored,
      data: result,
      ...(result.restored
        ? { message: `Restored ${result.hosts.length} route(s) from the last snapshot` }
        : { error: 'No snapshot has been taken yet' }),
    } as ApiResponse);
  } catch (error: any) {
    console.error('Error restoring Caddy config:', error);
    return res.status(502).json({
      success: false,
      error: error?.message || 'Could not restore the Caddy config',
    } as ApiResponse);
  }
});

/** Compare live Caddy routes against what should be there, and heal the gaps. */
router.post('/caddy/heal', authenticateToken, requireRole(['SUPERADMIN']), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json({ success: true, message: await healCaddyRoutes() } as ApiResponse);
  } catch (error: any) {
    console.error('Error healing Caddy routes:', error);
    return res.status(502).json({
      success: false,
      error: error?.message || 'Could not reach Caddy',
    } as ApiResponse);
  }
});

router.post('/detect', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { repository, branch, files } = req.body || {};
    // an app's folder in a monorepo (git flow; an upload sends that folder's files itself)
    const rootDirectory = cleanRootDirectory(req.body?.rootDirectory);
    if (rootDirectory && !ROOT_DIRECTORY_RE.test(rootDirectory)) {
      return res.status(400).json({ success: false, error: 'Root directory is a folder in the repository, like apps/web' } as ApiResponse);
    }

    // an app added to a project: its repository, read through the project's
    // clone account — which may be a teammate's; whoever sees the project may read it
    if (req.body?.sourceId) {
      const source = await prisma.source.findFirst({ where: { id: String(req.body.sourceId), ...(await projectScope(req)) } });
      if (!source?.repository) {
        return res.status(404).json({ success: false, error: 'Project not found, or not from a repository' } as ApiResponse);
      }
      const detected = await detectFromRepo(
        source.repository,
        source.branch || 'main',
        source.gitAccountId ? await gitAuthFor(source.gitAccountId) : undefined,
        rootDirectory,
      );
      return res.json({ success: true, data: detected } as ApiResponse);
    }

    if (files && typeof files === 'object') {
      const input: DetectInput = {};
      for (const name of DETECT_FILES) {
        if (typeof files[name] === 'string') input[name] = presenceOnly(name) ? '' : String(files[name]).slice(0, 256 * 1024);
      }
      return res.json({ success: true, data: detectFromFiles(input) } as ApiResponse);
    }

    if (typeof repository === 'string' && repository.trim()) {
      // a private repo: the account /branches found that can read it
      const gitAccountId = req.body?.gitAccountId ? String(req.body.gitAccountId) : null;
      if (!(await assertOwnGitAccount(gitAccountId, req.user!.userId, res))) return;
      const detected = await detectFromRepo(
        repository.trim(),
        String(branch || 'main').trim() || 'main',
        gitAccountId ? await gitAuthFor(gitAccountId) : undefined,
        rootDirectory,
      );
      return res.json({ success: true, data: detected } as ApiResponse);
    }

    return res.status(400).json({ success: false, error: 'Send files or a repository' } as ApiResponse);
  } catch (error: any) {
    return res.status(400).json({
      success: false,
      error: `Could not inspect the project: ${error?.stderr || error?.message || String(error)}`.slice(0, 500),
    } as ApiResponse);
  }
});

/**
 * A new project's repository in one clone: its root detected, and every app in
 * it — a monorepo's project starts with them as drafts.
 */
router.post('/detect-apps', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { repository, branch } = req.body || {};
    if (typeof repository !== 'string' || !repository.trim()) {
      return res.status(400).json({ success: false, error: 'Send a repository' } as ApiResponse);
    }
    const gitAccountId = req.body?.gitAccountId ? String(req.body.gitAccountId) : null;
    if (!(await assertOwnGitAccount(gitAccountId, req.user!.userId, res))) return;
    const detected = await detectAppsFromRepo(
      repository.trim(),
      String(branch || 'main').trim() || 'main',
      gitAccountId ? await gitAuthFor(gitAccountId) : undefined,
    );
    return res.json({ success: true, data: detected } as ApiResponse);
  } catch (error: any) {
    return res.status(400).json({
      success: false,
      error: `Could not inspect the project: ${error?.stderr || error?.message || String(error)}`.slice(0, 500),
    } as ApiResponse);
  }
});

/**
 * What an existing app's code looks like right now: commands, the env keys its
 * .env.example expects, whether it wants a database. Read from the repository
 * (through the app's git account) or from uploaded sources — never stored, so
 * the setup page always reflects the branch as it is.
 */
router.get('/:id/detect', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({
      where: { id: req.params.id as string, ...(await appScope(req)) },
      select: {
        id: true,
        type: true,
        composeEnvFiles: true,
        rootDirectory: true,
        packageManager: true,
        source: { select: { repository: true, branch: true, gitAccountId: true } },
      },
    });
    if (!application) return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);

    const source = application.source;
    const detected = source?.repository
      ? await detectFromRepo(
          source.repository,
          source.branch || 'main',
          source.gitAccountId ? await gitAuthFor(source.gitAccountId) : undefined,
          application.rootDirectory,
        )
      : await (async () => {
          const afs = await sourceFsFor(application.id);
          const sources = afs.sourcesDir;
          return detectProject(inRootDirectory(sources, application.rootDirectory), afs.readText, undefined, sources, application.packageManager);
        })();

    // The env files the app reads — configured, or found in its folder — each as
    // the repository ships it: what the deploy keeps, and overrides key by key.
    // From the checkout pulled on the node (the clone above never downloads a .env).
    const afs = await sourceFsFor(application.id).catch(() => null);
    if (afs) {
      const dir = inRootDirectory(afs.sourcesDir, application.rootDirectory);
      const found = (await afs.readdir(dir).catch(() => [] as string[])).filter(isEnvFile);
      const names = [...new Set([...compose.composeEnvFilesOf(application), ...found.sort()])];
      detected.env.files = await Promise.all(
        names.map(async (file) => ({
          file,
          vars: parseEnvFile(await afs.readText(path.posix.join(dir, file)).catch(() => '')).map(([key, value]) => ({ key, value })),
        })),
      );
    }

    return res.json({ success: true, data: detected } as ApiResponse);
  } catch (error: any) {
    return res.status(400).json({
      success: false,
      error: `Could not inspect the project: ${error?.stderr || error?.message || String(error)}`.slice(0, 500),
    } as ApiResponse);
  }
});

// Pulling and reading branches are the project's: routes/sources.ts

/**
 * Branches and the default branch of a pasted repository URL, for the add-app
 * form — and which of the caller's git accounts it needs.
 *
 * Public first, anonymously. When that fails and the URL is on GitHub/GitLab,
 * each of the caller's own accounts on that host is tried; the first that can
 * read it is returned as `gitAccountId` and becomes the app's clone account.
 * None can → `needsAccount` names the provider to connect. GitHub answers a
 * private repo and a missing one the same way, so that is all it can mean.
 */
router.post('/branches', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  const repository = String(req.body?.repository ?? '').trim();
  if (!repository) {
    return res.status(400).json({ success: false, error: 'Repository URL is required' } as ApiResponse);
  }

  let anonymousError: any;
  try {
    return res.json({ success: true, data: { ...(await listRemoteBranches(repository)), gitAccountId: null } } as ApiResponse);
  } catch (error) {
    anonymousError = error;
  }

  const provider = providerOf(repository, (await getGitOAuthConfig('gitlab')).oauthBase);
  if (provider) {
    // ponytail: one ls-remote per account, in turn — fine for the handful a user connects
    const accounts = await prisma.gitAccount.findMany({
      where: { userId: req.user!.userId, provider },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    for (const account of accounts) {
      try {
        const branches = await listRemoteBranches(repository, await gitAuthFor(account.id));
        return res.json({ success: true, data: { ...branches, gitAccountId: account.id } } as ApiResponse);
      } catch {
        // this account cannot see it; the next may
      }
    }
    return res.json({
      success: true,
      data: { defaultBranch: null, branches: [], gitAccountId: null, needsAccount: provider, triedAccounts: accounts.length },
    } as ApiResponse);
  }

  const detail = anonymousError?.stderr || anonymousError?.message || String(anonymousError);
  return res.status(400).json({
    success: false,
    error: `Could not read the branches: ${detail}`.slice(0, 500),
  } as ApiResponse);
});

router.get('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, limit, skip, search, organizationId } = paging(req);
    // ?type=PHP, ?serverId=…, ?domainId=… — anything not an AppType value is ignored, not a 500
    const type = String(req.query.type ?? '').trim().toUpperCase();
    const serverId = String(req.query.serverId ?? '').trim();
    // the parent domain: an app on shop.example.com belongs to example.com
    const domainId = String(req.query.domainId ?? '').trim();
    const where = {
      ...(await appScope(req)),
      // ?organizationId=unassigned: the synced rows nobody has claimed yet
      ...(organizationId && { organizationId: organizationId === 'unassigned' ? null : organizationId }),
      ...((Object.values(AppType) as string[]).includes(type) && { type: type as AppType }),
      ...(serverId && { serverId }),
      ...(domainId && { domains: { some: { domainId } } }),
      ...(search && { OR: [{ name: contains(search) }, { domains: { some: { host: contains(search) } } }] }),
    };

    const [applications, total] = await Promise.all([
      prisma.application.findMany({
        where,
        include: {
          organization: { select: { id: true, name: true, slug: true } },
          // which box it runs on — with more than one node, the row is
          // ambiguous without it
          server: { select: { id: true, name: true } },
          // its names, each with the domain it sits under (registration expiry flagged on the row)
          ...withDomains,
          source: true,
          deployments: {
            orderBy: {
              createdAt: 'desc',
            },
            take: 1,
          },
        },
        skip,
        take: limit,
        orderBy: sortOrder(req.query.sort, req.query.order),
      }),
      prisma.application.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);

    res.json({
      success: true,
      data: {
        data: applications.map(withSourceFields),
        pagination: {
          page,
          limit,
          total,
          totalPages,
        },
      },
      message: 'Applications retrieved successfully',
    } as ApiResponse<PaginatedResponse<Application>>);
  } catch (error) {
    console.error('Error fetching applications:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Get a specific application by ID
/**
 * Give many applications an owner at once.
 *
 * A node's sites arrive from the sync unassigned, and there can be fifty of
 * them — assigning one at a time is the whole reason this exists.
 */
router.patch('/bulk-assign', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { ids, organizationId } = req.body as { ids?: unknown; organizationId?: unknown };

    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) {
      return res.status(400).json({
        success: false,
        error: 'ids must be a non-empty array of application IDs',
      } as ApiResponse);
    }

    if (organizationId !== null && typeof organizationId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'organizationId must be an organization ID or null',
      } as ApiResponse);
    }

    if (organizationId) {
      const organization = await prisma.organization.findUnique({ where: { id: organizationId } });
      if (!organization) {
        return res.status(404).json({ success: false, error: 'Workspace not found' } as ApiResponse);
      }
    }

    // an org is its source's, and every app of that source goes with it
    // (req.body.sources: the ids are project ids, from the project list)
    const sourceIds = req.body?.sources === true
      ? (ids as string[])
      : (
          await prisma.application.findMany({ where: { id: { in: ids as string[] }, sourceId: { not: null } }, select: { sourceId: true } })
        ).map((app) => app.sourceId!);
    const count = await setSourceOrganization([...new Set(sourceIds)], (organizationId as string) || null);

    return res.json({
      success: true,
      data: { count },
      message: `${count} application(s) updated`,
    } as ApiResponse);
  } catch (error) {
    console.error('Error bulk assigning applications:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/**
 * Health for a set of applications: the recent beats, the day's uptime, and
 * whether the failures are enough to call it down.
 *
 * Batched because the list renders one bar per row — a request per row would
 * be 25 round trips for one screen.
 */
/**
 * Every hostname in scope (each binding: host + path) with its own uptime —
 * the monitor page. Before GET /health/:x and /:id, or express reads "hosts" as an id.
 */
router.get('/health/hosts', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const apps = await prisma.application.findMany({
      where: await appScope(req),
      select: {
        id: true,
        name: true,
        status: true,
        disabled: true,
        runtime: true,
        serve: true,
        sourceId: true,
        source: { select: { name: true, repository: true, path: true } },
        domains: { select: { host: true, path: true }, orderBy: [{ host: 'asc' }, { path: 'asc' }] },
      },
    });
    const rows = apps.flatMap((app) =>
      app.domains
        // names that only exist inside the platform have nothing to check
        .filter((d) => !d.host.endsWith('.local'))
        .map((d) => ({
          id: `${d.host}${d.path}`,
          host: d.host,
          path: d.path,
          service: { id: app.id, name: app.name, status: app.status, disabled: app.disabled },
          app: app.sourceId && app.source ? { id: app.sourceId, name: sourceName(app.source, app.domains[0]?.host) } : null,
          serving: isServing(app),
        })),
    );
    const health = await healthFor('HOSTNAME', rows.map((row) => row.id));
    // nothing of its own routed yet: no verdict (see GET /health)
    const data = rows.map(({ serving, ...row }) => ({ ...row, health: serving ? health[row.id] : { ...health[row.id]!, state: 'unknown', beats: [], uptime24h: null } }));
    return res.json({ success: true, data } as ApiResponse);
  } catch (error) {
    console.error('Error reading hostname health:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

router.get('/health', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ids = String(req.query.ids ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 100);

    if (ids.length === 0) return res.json({ success: true, data: {} } as ApiResponse);

    // only applications the caller may see — the ids arrive from the client
    const visible = await prisma.application.findMany({
      where: { id: { in: ids }, ...(await appScope(req)) },
      select: { id: true, runtime: true, serve: true },
    });

    const health = await healthFor('APPLICATION', visible.map((app) => app.id));
    // nothing of its own routed yet: no verdict — its old beats (from before, or
    // another app answering on its host) would read as "online"
    for (const app of visible) {
      if (!isServing(app) && health[app.id]) health[app.id] = { ...health[app.id]!, state: 'unknown', beats: [], uptime24h: null };
    }
    return res.json({ success: true, data: health } as ApiResponse);
  } catch (error) {
    console.error('Error reading application health:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/**
 * What a hostname is today — taken by another app, already pointing somewhere,
 * the bare domain — so the create and move forms can warn before anything is
 * changed. Before GET /:id, or express reads "hostname-check" as an id.
 */
router.get('/hostname-check', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const host = normalizeHost(req.query.host);
    if (!host.includes('.')) return res.status(400).json({ success: false, error: 'host is required' } as ApiResponse);
    const param = (name: string) => (typeof req.query[name] === 'string' && req.query[name]) || undefined;
    const data = await inspectHost(req, host, {
      excludeAppId: param('exclude') as string | undefined,
      // the node the new app would get, so the preview shows its real address
      serverId: param('serverId') as string | undefined,
      organizationId: param('organizationId') as string | undefined,
      // a path under the name: who has that path, not the whole name
      path: normalizeBindingPath(param('path')) ?? '',
    });
    return res.json({ success: true, data } as ApiResponse);
  } catch (error) {
    console.error('Error checking hostname:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

router.get('/:id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    console.log('Get application request:', {
      params: req.params,
      url: req.url,
      method: req.method
    });

    const { id } = req.params || {};

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    const application = await prisma.application.findFirst({
      where: {
        id,
        ...(await appScope(req)),
      },
      include: {
        deployments: {
          orderBy: {
            createdAt: 'desc',
          },
        },
        // where it runs: its own node, else its organization's default server
        // (the order serverForApplication routes through). Never SSH fields.
        server: { select: { id: true, name: true, hostname: true, publicIp: true, tags: true } },
        organization: {
          select: { defaultServer: { select: { id: true, name: true, hostname: true, publicIp: true, tags: true } } },
        },
        ...withDomains,
        source: true,
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    return res.json({
      success: true,
      data: {
        ...withSourceFields(application),
        // the detail page edits them; everywhere else only the sealed blob goes out
        envVars: readEnv(application.envVars),
        extraEnvVars: readEnvFiles(application.extraEnvVars),
        // saved once, even empty: someone looked at it — the setup checklist waits for that
        envConfirmed: application.envVars !== null,
        placement: application.server ?? application.organization?.defaultServer ?? null,
      },
      message: 'Application retrieved successfully',
    } as ApiResponse<Application>);
  } catch (error) {
    console.error('Error fetching application:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Create a new application
router.post('/', authenticateToken, validateRequest(CreateApplicationSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, type, repository, branch, installCommand, buildCommand, preDeployCommand, startCommand, port, envVars, gitAccountId } = req.body;
    const { composeFiles, composeEnvFiles, composePort, composeService } = req.body;
    const domain = normalizeHost(req.body.domain);
    const rootDirectory = cleanRootDirectory(req.body.rootDirectory);

    if (!(await assertOwnGitAccount(gitAccountId, req.user!.userId, res))) return;

    // An app added to an existing project ("Tambah Aplikasi"): no source of its
    // own — it builds with the project's other apps, from the same commit, so it
    // runs on the project's node and belongs to the project's organization.
    const joining = req.body.sourceId
      ? await prisma.source.findFirst({
          where: { id: String(req.body.sourceId), ...(await projectScope(req)) },
        })
      : null;
    if (req.body.sourceId) {
      if (!joining) return res.status(404).json({ success: false, error: 'Project not found' } as ApiResponse);
      if (joining.path) {
        return res.status(400).json({
          success: false,
          error: 'This project was imported from its server — its apps are the sites served from that folder',
        } as ApiResponse);
      }
      if (!joining.serverId) {
        return res.status(409).json({ success: false, error: 'This project has no server yet — deploy it once first' } as ApiResponse);
      }
    }

    // With a host: the host decides the org. Without one — an app created first,
    // its hosts added from its page later — the project's org, the one asked
    // for, or the caller's only one; a member's either way.
    let parentDomain: Extract<Awaited<ReturnType<typeof resolveAppHost>>, { parent: unknown }>['parent'] | null = null;
    let organizationId: string | null;
    if (domain) {
      // one name, one app — whichever of its names it is
      if (await appIdAt(domain)) {
        return res.status(400).json({
          success: false,
          error: 'Domain already in use',
        } as ApiResponse);
      }

      // Ownership boundary: the hostname sits under a domain owned by one of the
      // caller's organizations (the app inherits that org), or under a shared
      // platform domain (the app belongs to the caller's org).
      const resolved = await resolveAppHost(req, domain, joining?.organizationId ?? req.body.organizationId);
      if ('error' in resolved) {
        return res.status(resolved.status).json({ success: false, error: resolved.error } as ApiResponse);
      }
      parentDomain = resolved.parent;
      organizationId = resolved.organizationId;
      // a name another organization's app already answers on (at a path) is theirs
      const otherOrg = await hostRefused(domain, organizationId);
      if (otherOrg) return res.status(403).json({ success: false, error: otherOrg } as ApiResponse);
      if (joining?.organizationId && organizationId !== joining.organizationId) {
        return res.status(403).json({
          success: false,
          error: "That domain belongs to another workspace — pick one of this app's workspace",
        } as ApiResponse);
      }
    } else {
      const orgIds = await getOrgIds(req);
      // none picked: the org switched to in the sidebar, or the only one
      const active = (await listMemberships(req)).map((m) => m.organizationId);
      organizationId = joining?.organizationId ?? req.body.organizationId ?? (active.length === 1 ? active[0]! : null);
      if (!organizationId) {
        return res.status(400).json({ success: false, error: 'Pick the workspace this app belongs to' } as ApiResponse);
      }
      if (!isPlatformAdmin(req) && !orgIds.includes(organizationId)) {
        return res.status(403).json({ success: false, error: 'You are not a member of that workspace' } as ApiResponse);
      }
    }

    // Which node it runs on: a superadmin may pick one, everyone else gets the
    // organization's default server. An org spans nodes — this is per app.
    const org = organizationId
      ? await prisma.organization.findUnique({ where: { id: organizationId }, select: { defaultServerId: true } })
      : null;
    const requested = joining
      ? joining.serverId
      : req.user!.role === 'SUPERADMIN' && typeof req.body.serverId === 'string'
        ? req.body.serverId
        : null;
    if (requested && !(await prisma.server.findUnique({ where: { id: requested }, select: { id: true } }))) {
      return res.status(400).json({ success: false, error: 'Unknown server' } as ApiResponse);
    }
    let serverId = requested ?? org?.defaultServerId ?? null;
    // Nobody picked a node and there is no default (or, for a stack, the default
    // runs no containers) → the online node with the most free disk that fits.
    if (!requested) {
      const fitsType = type === 'COMPOSE' ? { containerRuntime: { not: 'NONE' } } : {};
      const fits = serverId && (await prisma.server.findFirst({ where: { id: serverId, ...fitsType }, select: { id: true } }));
      if (!fits) {
        const nodes = await prisma.server.findMany({
          where: { ...fitsType, provisioned: true, status: 'ONLINE' },
          select: { id: true, disk: true },
        });
        // disk is { size, used, avail } from the heartbeat; unmeasured counts as 0
        const avail = (n: (typeof nodes)[number]) => Number((n.disk as { avail?: number } | null)?.avail ?? 0);
        serverId = nodes.sort((a, b) => avail(b) - avail(a))[0]?.id ?? serverId;
      }
    }
    if (!serverId) {
      return res.status(400).json({
        success: false,
        error: "No online server to run this app — ask an administrator to set one up, or set the workspace's default server.",
      } as ApiResponse);
    }

    const node = await prisma.server.findUnique({ where: { id: serverId } });
    if (!node) {
      return res.status(400).json({ success: false, error: 'Unknown server' } as ApiResponse);
    }
    // Said here rather than at the first deploy: "pick another node" is a
    // different answer from a red build log three screens later.
    if (type === 'COMPOSE' && node.containerRuntime === 'NONE') {
      return res.status(400).json({
        success: false,
        error: `${node.name} has no container runtime — pick a node that runs one, or turn it on for this node and run Set up again.`,
      } as ApiResponse);
    }

    const taken = domain && parentDomain ? await sharedHostTaken(parentDomain, domain, node) : null;
    if (taken) {
      return res.status(409).json({ success: false, error: taken } as ApiResponse);
    }

    // its first name, if it was given one; more (or the first) are added from its page
    const at = domain && parentDomain ? { host: domain, domainId: parentDomain.id } : null;
    const fields = {
      name,
      domains: { create: at ? [at] : [] },
      type,
      rootDirectory,
      installCommand,
      buildCommand,
      preDeployCommand,
      startCommand,
      port,
      ...(envVars && { envVars: sealEnv(envVars) }),
      ...(composeFiles !== undefined && { composeFiles }),
      ...(composeEnvFiles !== undefined && { composeEnvFiles }),
      ...(composePort !== undefined && { composePort }),
      ...(composeService !== undefined && { composeService }),
      userId: req.user!.userId,
      organizationId,
      serverId,
    };
    const application = withSourceFields(
      joining
        ? await prisma.application.create({ data: { ...fields, sourceId: joining.id }, include: { source: true } })
        : // a new project: the name typed is the project's (its first app starts with it too, unless named apart)
          await createApplicationWithSource(fields, { repository, gitAccountId, branch, name: String(req.body.projectName || name).trim() || null }),
    );

    // Provision the org on that node now, so the first deploy does not wait
    // for it (the deploy still checks, and waits if this has not finished).
    // Static sites are served from R2, but build on the node too (its build cgroup).
    if (organizationId && serverId) {
      await queueOrgNode(organizationId, serverId, { userId: req.user!.userId, trigger: 'app-create' }).catch(
        (error) => console.error(`Could not queue provisioning for ${domain}:`, error),
      );
      // A new project from git: its code is pulled onto the node once, now —
      // no build, no start — so it is there to look at before the first deploy.
      // In the background: provisioning can take a while, the create does not wait.
      if (!joining && repository) {
        const userId = req.user!.userId;
        const at = branch || 'main';
        const log = (level: 'INFO' | 'ERROR', message: string) =>
          prisma.log.create({ data: { level, message, userId, applicationId: application.id } }).catch(() => {});
        void (async () => {
          try {
            await ensureOrgOnNode(organizationId, serverId, { userId, trigger: 'app-create' });
            const afs = await sourceFsFor(application.id);
            const dir = await deploymentService.syncRepository(afs, repository, at, gitAccountId ?? null);
            const { stdout } = await afs.run(['git', 'log', '-1', '--format=%h %s'], { cwd: dir });
            await log('INFO', `Code pulled for ${application.name}: ${at} is at ${stdout.trim()}`);
          } catch (error: any) {
            await log('ERROR', `First pull of ${application.name} failed: ${String(error?.message || error).slice(0, 500)}`);
          }
        })();
      }
    }

    // Point the hostname at the platform now, so the app is reachable the
    // moment it deploys. A hostname already pointing somewhere else is left
    // alone and reported — the caller can retry with ?force=1.
    // dnsConsent: the user agreed on the form to replace what the name points at
    // (and to move a registrar domain to Cloudflare) — the form showed exactly what
    const consent = req.body.dnsConsent === true || req.query.force === '1';
    const dns =
      domain && parentDomain
        ? await applyAppDns(req, { id: application.id, domain, domainId: parentDomain.id }, consent).catch(
            (error: any) => ({ state: 'unavailable' as const, detail: String(error?.message ?? 'DNS setup failed') }),
          )
        : null;

    return res.status(201).json({
      success: true,
      data: {
        ...application,
        domains:
          at && parentDomain
            ? [{ ...at, parentDomain: { id: parentDomain.id, name: parentDomain.name, expiresAt: parentDomain.expiresAt, shared: parentDomain.shared } }]
            : [],
        dns,
      },
      message:
        dns && (dns.state === 'conflict' || dns.state === 'unavailable')
          ? `Application created, but DNS was not set up: ${dns.detail}`
          : 'Application created successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error creating application:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// ---------------------------------------------------------------------------
// Uploaded sources: an app can be deployed from a folder the user picked in the
// browser instead of a git repository. Files land straight in the app's
// sources/ directory, which is what the deploy step builds from.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 5000 },
});

/** Keeps an uploaded relative path inside sources/ — a client can send anything. */
const safeRelativePath = (raw: string): string | null => {
  const cleaned = String(raw || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();

  if (!cleaned) return null;
  if (cleaned.split('/').some((part) => part === '..' || part === '.' || !part)) return null;
  if (path.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) return null;

  return cleaned;
};

router.post(
  '/:id/source',
  authenticateToken,
  upload.array('files'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const files = (req.files as Express.Multer.File[]) || [];

      if (files.length === 0) {
        return res.status(400).json({ success: false, error: 'No files uploaded' } as ApiResponse);
      }

      const application = await prisma.application.findFirst({
        where: { id: id as string, ...(await appScope(req)) },
      });

      if (!application) {
        return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
      }

      // paths[i] carries the file's path inside the picked folder; a plain file
      // upload has none, so fall back to its own name
      const rawPaths = req.body?.paths;
      const paths: string[] = Array.isArray(rawPaths) ? rawPaths : rawPaths ? [rawPaths] : [];

      // Static sites live in their own R2 bucket and are served through
      // Cloudflare, so their files never touch our disk. Runtime apps still
      // need a sources/ tree for the build step.
      if (application.type === 'STATIC') {
        // An upload is this app's deploy, so it gets a row in the history —
        // including when it fails, which is when the history matters most.
        const deployment = await prisma.deployment.create({
          data: { status: 'DEPLOYING', applicationId: application.id, sourceId: application.sourceId, userId: req.user!.userId },
        });
        const fail = async (status: number, message: string) => {
          await prisma.deployment.update({
            where: { id: deployment.id },
            data: { status: 'FAILED', deployLogs: message },
          });
          // the previous release is still serving untouched — only a site with
          // nothing up yet is actually in error
          if (!application.staticOrigin) {
            await prisma.application.update({ where: { id: application.id }, data: { status: 'ERROR' } });
          }
          return res.status(status).json({ success: false, error: message } as ApiResponse);
        };

        // A fresh folder per deploy (services/staticReleaseService.ts): the
        // serving one is never written to, and the switch is the route.
        const folder = releaseFolder(deployment.id);
        let bucket: string;
        let origin: string;
        const uploadedKeys = new Set<string>();
        let carried = 0;

        try {
          ({ bucket, origin } = await siteStorage(application));
          await adoptRootFiles(application);

          for (const [index, file] of files.entries()) {
            const relative = safeRelativePath(paths[index] || file.originalname);
            if (!relative) continue;

            if (await uploadSiteObject(inFolder(bucket, folder), relative, file.buffer)) uploadedKeys.add(relative);
          }

          // Without ?replace the upload only adds and overwrites: the rest of
          // the serving release is carried into the new one, copied inside R2.
          const replace = req.body?.replace === 'true' || req.body?.replace === true;
          if (uploadedKeys.size > 0 && !replace && application.staticOrigin) {
            const serving = servingFolder(application.staticOrigin);
            const keep = (await listReleaseFiles(bucket, serving)).map((f) => f.key).filter((key) => !uploadedKeys.has(key));
            carried = await copySiteObjects(inFolder(bucket, serving), inFolder(bucket, folder), keep);
          }
        } catch (error: any) {
          if (uploadedKeys.size > 0) await discardFolder(bucket!, folder);
          return fail(500, error?.message || 'Could not upload to the site bucket');
        }

        const uploaded = uploadedKeys.size;
        if (uploaded === 0) {
          return fail(400, 'No usable files in the upload');
        }

        const release = await prisma.release.create({
          data: { applicationId: application.id, sourceId: application.sourceId, status: 'READY', path: folder, deploymentId: deployment.id },
        });
        const pointer = { staticBucket: bucket, staticOrigin: inFolder(origin, folder), activeReleaseId: release.id };

        try {
          await serveStatic(await serverForApplication(application.id), application.id, pointer.staticOrigin);
        } catch (error: any) {
          // nothing served before: point at the new release anyway, so a
          // republish retries just the route. Otherwise the old one keeps
          // serving and the new release waits in the list to be switched to.
          if (!application.staticOrigin) {
            await prisma.application.update({ where: { id: application.id }, data: pointer });
          }
          return fail(502, staticRouteError(error));
        }

        // DNS is a warning, not a failure: the hostname may live in a zone
        // someone else runs, and the site itself is up
        let dnsWarning = '';
        for (const at of atEach({ id: application.id, domains: await prisma.appDomain.findMany({ where: { applicationId: application.id }, orderBy: { host: 'asc' } }) })) {
          const dns = await ensureAppHostname(at).catch(
            (error: any) => ({ state: 'unavailable' as const, detail: String(error?.message ?? 'DNS setup failed') }),
          );
          if (dns.state === 'conflict' || dns.state === 'unavailable') dnsWarning += `\nDNS was not set up for ${at.domain}: ${dns.detail}`;
        }

        await prisma.deployment.update({
          where: { id: deployment.id },
          data: {
            status: 'SUCCESS',
            deployLogs:
              `Uploaded ${uploaded} file${uploaded === 1 ? '' : 's'} to Cloudflare R2 (${inFolder(bucket, folder)})` +
              (carried ? `, carried over ${carried} unchanged from the previous release` : '') +
              dnsWarning,
          },
        });
        await prisma.application.update({
          where: { id: application.id },
          data: { ...pointer, status: 'RUNNING', lastDeployment: new Date() },
        });
        await pruneStaticReleases(application.id);

        return res.json({
          success: true,
          data: { files: uploaded },
          message: dnsWarning ? `Static files uploaded, but${dnsWarning}` : 'Static files uploaded to Cloudflare R2',
        } as ApiResponse);
      }

      // on the org's node when the app lives there (lib/appFs.ts)
      const afs = await deploymentService.prepareAppDirectory(application.id);
      const sourcesDir = afs.sourcesDir;

      // a fresh upload replaces the previous one — leftovers would ship in the build
      await afs.rm(sourcesDir, { recursive: true, force: true });
      await afs.mkdir(sourcesDir);

      let written = 0;
      for (const [index, file] of files.entries()) {
        const relative = safeRelativePath(paths[index] || file.originalname);
        if (!relative) continue;

        const target = path.posix.join(sourcesDir, relative);
        if (!target.startsWith(sourcesDir + '/')) continue;

        // ponytail: one mkdir + one SFTP write per file. Tar over one channel if big uploads get slow.
        await afs.mkdir(path.posix.dirname(target));
        await afs.writeFile(target, file.buffer);
        written += 1;
      }

      if (written === 0) {
        return res.status(400).json({ success: false, error: 'No usable files in the upload' } as ApiResponse);
      }

      return res.json({
        success: true,
        data: { files: written },
        message: 'Source files uploaded successfully',
      } as ApiResponse);
    } catch (error) {
      console.error('Error uploading application source:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
    }
  }
);

// ---------------------------------------------------------------------------
// Static site files: what is in the app's R2 bucket, and removing some of it.
// Adding files goes through POST /:id/source like any upload (with replace=true
// the upload becomes the whole site). No rename/move: a static site is
// redeployed whole, not edited in place.

/** The static app with its bucket, or the response that says why not. */
async function siteBucketFor(req: AuthenticatedRequest, res: Response) {
  const application = await prisma.application.findFirst({
    where: { id: req.params.id as string, ...(await appScope(req)) },
  });
  if (!application) {
    res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    return null;
  }
  if (application.type !== 'STATIC' || !application.staticBucket) {
    res.status(400).json({ success: false, error: 'This app has no uploaded site files' } as ApiResponse);
    return null;
  }
  return application as typeof application & { staticBucket: string };
}

router.get('/:id/files', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await siteBucketFor(req, res);
    if (!application) return;

    return res.json({
      success: true,
      data: {
        // public bucket host of the serving release, so a file can be opened
        // before DNS points here
        origin: application.staticOrigin,
        // the release that is serving — not every release in the bucket
        files: await listReleaseFiles(application.staticBucket, servingFolder(application.staticOrigin)),
      },
    } as ApiResponse);
  } catch (error: any) {
    console.error('Error listing site files:', error);
    return res.status(502).json({ success: false, error: error?.message || 'Could not list the files' } as ApiResponse);
  }
});

router.delete('/:id/files', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await siteBucketFor(req, res);
    if (!application) return;

    const raw: unknown[] = Array.isArray(req.body?.keys) ? req.body.keys : [];
    // same shape check as uploads: plain relative paths, no traversal
    const keys = raw.map((key) => safeRelativePath(String(key))).filter((key): key is string => !!key);
    if (keys.length === 0) {
      return res.status(400).json({ success: false, error: 'No files to delete' } as ApiResponse);
    }

    // from the serving release; earlier releases keep their copies
    const deleted = await deleteSiteObjects(
      inFolder(application.staticBucket, servingFolder(application.staticOrigin)),
      keys,
    );
    return res.json({ success: true, data: { deleted } } as ApiResponse);
  } catch (error: any) {
    console.error('Error deleting site files:', error);
    return res.status(502).json({ success: false, error: error?.message || 'Could not delete the files' } as ApiResponse);
  }
});

// Update an application
router.put('/:id', authenticateToken, validateRequest(UpdateApplicationSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    // no request logging here: the body carries the app's env vars (secrets)
    const { id } = req.params || {};
    // hostnames are not edited here: POST/DELETE /:id/domains
    const { name, type, repository, branch, installCommand, buildCommand, preDeployCommand, pruneDevDeps, startCommand, port, envVars, extraEnvVars, gitAccountId, rootDirectory, packageManager } =
      req.body || {};
    const { composeFiles, composeEnvFiles, composePort, composeService } = req.body || {};
    if (packageManager !== undefined && packageManager !== null && packageManager !== '' && !['npm', 'pnpm', 'yarn', 'bun'].includes(packageManager)) {
      return res.status(400).json({ success: false, error: 'packageManager must be npm, pnpm, yarn or bun' });
    }
    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    // Check if application exists and belongs to user
    const existingApp = await prisma.application.findFirst({
      where: {
        id,
        ...(await appScope(req)),
      },
    });

    if (!existingApp) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    if (!(await assertOwnGitAccount(gitAccountId, req.user!.userId, res))) return;
    // an imported app's env is its .env on the server, mirrored by the sync — an edit here would reach nothing
    if ((envVars !== undefined || extraEnvVars !== undefined) && existingApp.runtime) {
      return res.status(400).json({ success: false, error: "An imported app's environment is its .env on the server — change it there, then sync" } as ApiResponse);
    }

    // where the code comes from is the source's, shared with its other apps
    if (existingApp.sourceId && (repository !== undefined || branch !== undefined || gitAccountId !== undefined)) {
      await prisma.source.update({
        where: { id: existingApp.sourceId },
        // undefined leaves it alone; null deliberately clears it
        data: { repository, branch, ...(gitAccountId !== undefined && { gitAccountId }) },
      });
    }

    // Update application
    const updatedApp = await prisma.application.update({
      where: { id },
      include: { source: true, ...withDomains },
      data: {
        name,
        type,
        // '' / null: back to the repository root
        ...(rootDirectory !== undefined && { rootDirectory: cleanRootDirectory(rootDirectory) }),
        // '' clears back to the detected install / no pre-deploy step
        ...(installCommand !== undefined && { installCommand: installCommand.trim() || null }),
        // '' / null: back to the lockfile's
        ...(packageManager !== undefined && { packageManager: packageManager || null }),
        buildCommand,
        ...(preDeployCommand !== undefined && { preDeployCommand: preDeployCommand.trim() || null }),
        ...(typeof pruneDevDeps === 'boolean' && { pruneDevDeps }),
        startCommand,
        port,
        ...(envVars !== undefined && { envVars: sealEnv(envVars) }),
        ...(extraEnvVars !== undefined && { extraEnvVars: sealEnvFiles(extraEnvVars) }),
        // '' / null on either of the last two: no port is republished and no
        // default service for exec — the stack keeps what its own files say.
        ...(composeFiles !== undefined && { composeFiles }),
        ...(composeEnvFiles !== undefined && { composeEnvFiles }),
        ...(composePort !== undefined && { composePort: composePort || null }),
        ...(composeService !== undefined && { composeService: composeService || null }),
      },
    });

    return res.json({
      success: true,
      data: { ...withSourceFields(updatedApp), envVars: readEnv(updatedApp.envVars), extraEnvVars: readEnvFiles(updatedApp.extraEnvVars), envConfirmed: updatedApp.envVars !== null },
      message: 'Application updated successfully',
    } as ApiResponse<Application>);
  } catch (error) {
    // not the body or headers: they carry the env vars and the bearer token
    console.error('Error updating application:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

/**
 * Where a binding may redirect to: another of the same app's whole names that
 * serves it (not itself a redirect), so a redirect never chains or loops.
 * null when it may, else why not. Pure.
 */
function redirectRefused(domains: Array<{ host: string; path: string; redirectTo: string | null }>, host: string, target: string): string | null {
  if (target === host) return 'A name cannot redirect to itself';
  if (!domains.some((d) => d.host === target && d.path === '' && !d.redirectTo)) {
    return `${target} is not a name this app is served on — add it first, then redirect to it`;
  }
  return null;
}

/** The app's bindings that redirect to `host` — a name they need, so it cannot go or redirect itself. */
const redirectsTo = (domains: Array<{ host: string; path: string; redirectTo: string | null }>, host: string) =>
  domains.filter((d) => d.redirectTo === host).map((d) => `${d.host}${d.path}`);

/**
 * Bind an app to one more hostname, or a path under one (`/api/*`). All its
 * bindings are alike. The name's route is composed again with it — beside
 * whatever other apps of the organization answer on that name — and a name
 * new to the platform is pointed at the app's node. A route that cannot be set
 * takes the binding back off: nothing half-added.
 */
router.post('/:id/domains', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({
      where: { id: req.params.id as string, ...(await appScope(req)) },
      include: { organization: { select: { slug: true } }, ...withDomains },
    });
    if (!application) return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);

    const host = normalizeHost(req.body?.host);
    if (!host) return res.status(400).json({ success: false, error: 'Hostname is required' } as ApiResponse);
    const at = normalizeBindingPath(req.body?.path);
    if (at === null) return res.status(400).json({ success: false, error: 'A path is like /api/* — or leave it empty for the whole name' } as ApiResponse);
    const stripPrefix = at !== '' && req.body?.stripPrefix === true;
    const label = `${host}${at}`;
    // answers with a 301 to another of its names instead of serving the app
    const redirectTo = req.body?.redirectTo ? normalizeHost(req.body.redirectTo) : null;
    if (req.body?.redirectTo && !redirectTo) return res.status(400).json({ success: false, error: 'Redirect to a hostname, like app.example.com' } as ApiResponse);
    const redirectWhy = redirectTo && redirectRefused(application.domains, host, redirectTo);
    if (redirectWhy) return res.status(400).json({ success: false, error: redirectWhy } as ApiResponse);
    // a name and its paths belong to one organization
    const otherOrg = await hostRefused(host, application.organizationId);
    if (otherOrg) return res.status(403).json({ success: false, error: otherOrg } as ApiResponse);

    const node = await serverForApplication(application.id);
    // held by another app: taken over only when asked (`move`), from an app of the same organization
    const holderId = await appIdAt(host, at);
    let movedFrom: { id: string; name: string } | null = null;
    if (holderId) {
      if (holderId === application.id || req.body?.move !== true) {
        return res.status(400).json({ success: false, error: `${label} is already in use` } as ApiResponse);
      }
      const holder = await prisma.application.findFirst({
        where: { id: holderId, AND: [{ organizationId: application.organizationId }, await appScope(req)] },
        select: { id: true, name: true },
      });
      if (!holder) return res.status(403).json({ success: false, error: `${label} belongs to an app you cannot manage` } as ApiResponse);
      // its last host may go too: agreed to on purpose, and an app without a host is a state apps already have (before their first)
      // ponytail: same server only; across servers needs the old node's route dropped and DNS repointed
      if ((await serverForApplication(holder.id)).id !== node.id) {
        return res.status(400).json({ success: false, error: `${holder.name} runs on another server — ${label} can only move between apps on the same server` } as ApiResponse);
      }
      movedFrom = { id: holder.id, name: holder.name };
    }
    // a name its organization already serves: its zone and DNS are settled; a new one is checked like on create
    const sibling = await prisma.appDomain.findFirst({ where: { host }, select: { domainId: true } });
    let domainId = sibling?.domainId ?? null;
    if (!sibling) {
      // same ownership boundary as create — and a name never moves the app to another org
      const resolved = await resolveAppHost(req, host, application.organizationId);
      if ('error' in resolved) return res.status(resolved.status).json({ success: false, error: resolved.error } as ApiResponse);
      if (application.organizationId && resolved.organizationId !== application.organizationId) {
        return res.status(403).json({ success: false, error: "That domain belongs to another workspace — pick one of this app's workspace" } as ApiResponse);
      }
      const taken = await sharedHostTaken(resolved.parent, host, node);
      if (taken) return res.status(409).json({ success: false, error: taken } as ApiResponse);
      domainId = resolved.parent.id;
    }

    if (movedFrom) {
      await prisma.appDomain.update({ where: { host_path: { host, path: at } }, data: { applicationId: application.id, stripPrefix, redirectTo } });
    } else {
      await prisma.appDomain.create({ data: { host, path: at, stripPrefix, redirectTo, applicationId: application.id, domainId } });
    }
    // a panel app never deployed: nothing of it to serve yet (an imported one has a runtime and its own
    // route; an uploaded site has files in its bucket without any deployment)
    const neverDeployed =
      !application.runtime &&
      !application.staticOrigin &&
      !(await prisma.deployment.count({ where: { applicationId: application.id, status: 'SUCCESS' } }));
    try {
      if (redirectTo) {
        // needs nothing of the app: the name's route composed with the redirect
        await recomposeHosts(node, [host]);
      } else if (neverDeployed) {
        // the "ready, waiting for its first deploy" page until then — the deploy routes it for real (serveApp)
        await serveApp(node, application.id, { kind: 'placeholder' });
      } else if (readServe(application.serve)) {
        // known: the name's route composed with it, beside whatever else it serves
        await recomposeHosts(node, [host]);
      } else if (application.runtime) {
        // someone else's route, whose shape the panel does not know: a path cannot be cut into it
        if (at) throw new Error('the panel does not know what this app is served by yet — sync the apps first');
        // served as its other names are, one more host on it
        const beside = hostsOf(application).find((name) => !name.endsWith('.pm2.local'));
        if (beside) await addCaddyHost(node, beside, host);
      } else if (application.status === 'RUNNING') {
        await deploymentService.applyCaddyRoute(application);
      }
    } catch (error: any) {
      // nothing half-done: a moved name goes back to its app, a new one goes
      if (movedFrom) {
        await prisma.appDomain.update({ where: { host_path: { host, path: at } }, data: { applicationId: movedFrom.id } });
        await recomposeHosts(node, [host]).catch(() => {});
      } else {
        await prisma.appDomain.delete({ where: { host_path: { host, path: at } } });
      }
      return res.status(502).json({ success: false, error: `${label} could not be routed: ${error?.message ?? error}` } as ApiResponse);
    }

    // a name new to the platform gets its record; one already served has it
    const dns = sibling
      ? { state: 'exists' as const, detail: `${host} already points here` }
      : await applyAppDns(req, { id: application.id, domain: host, domainId }, req.body?.dnsConsent === true).catch(
          (error: any) => ({ state: 'unavailable' as const, detail: String(error?.message ?? 'DNS setup failed') }),
        );
    await prisma.log.create({
      data: {
        level: 'INFO',
        message: movedFrom
          ? `${label} moved from ${movedFrom.name} to ${application.name}`
          : `${label} added to ${application.name}${redirectTo ? `, redirecting to ${redirectTo}` : ''}`,
        userId: req.user!.userId,
        applicationId: application.id,
      },
    });
    return res.status(201).json({
      success: true,
      data: { host, path: at, dns },
      message: dns.state === 'conflict' || dns.state === 'unavailable' ? `${label} added, but DNS was not set up: ${dns.detail}` : `${label} added`,
    } as ApiResponse);
  } catch (error) {
    console.error('Error adding a binding:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/**
 * Change one binding: hand the app its path with or without the prefix
 * (`/api/users` or `/users`), or make it redirect to another of the app's names
 * (`redirectTo`, null to serve the app again). The name's route composed again.
 */
router.patch('/:id/domains', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({ where: { id: req.params.id as string, ...(await appScope(req)) }, include: withDomains });
    if (!application) return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    const host = normalizeHost(req.body?.host);
    const at = normalizeBindingPath(req.body?.path);
    const binding = at === null ? undefined : application.domains.find((d) => d.host === host && d.path === at);
    if (!binding || at === null) return res.status(404).json({ success: false, error: `${host}${at ?? ''} is not one of this app's names` } as ApiResponse);
    const label = `${host}${at}`;
    const data: { stripPrefix?: boolean; redirectTo?: string | null } = {};
    if ('stripPrefix' in (req.body ?? {})) {
      if (!at) return res.status(400).json({ success: false, error: 'Only a path of one of its names can drop its prefix' } as ApiResponse);
      data.stripPrefix = req.body.stripPrefix === true;
    }
    if ('redirectTo' in (req.body ?? {})) {
      const redirectTo = req.body.redirectTo ? normalizeHost(req.body.redirectTo) : null;
      if (req.body.redirectTo && !redirectTo) return res.status(400).json({ success: false, error: 'Redirect to a hostname, like app.example.com' } as ApiResponse);
      if (redirectTo) {
        const why = redirectRefused(application.domains, host, redirectTo);
        if (why) return res.status(400).json({ success: false, error: why } as ApiResponse);
        const needed = at ? [] : redirectsTo(application.domains, host);
        if (needed.length) return res.status(400).json({ success: false, error: `${needed.join(', ')} redirect to ${host} — change them first` } as ApiResponse);
      }
      data.redirectTo = redirectTo;
    }
    await prisma.appDomain.update({ where: { host_path: { host, path: at } }, data });
    try {
      await recomposeHosts(await serverForApplication(application.id), [host]);
    } catch (error: any) {
      await prisma.appDomain.update({ where: { host_path: { host, path: at } }, data: { stripPrefix: binding.stripPrefix, redirectTo: binding.redirectTo } });
      return res.status(502).json({ success: false, error: `${label} could not be routed: ${error?.message ?? error}` } as ApiResponse);
    }
    return res.json({ success: true, data: { host, path: at, stripPrefix: data.stripPrefix ?? binding.stripPrefix, redirectTo: data.redirectTo === undefined ? binding.redirectTo : data.redirectTo } } as ApiResponse);
  } catch (error) {
    console.error('Error changing a binding:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/**
 * Take a binding off an app (`?path=` for a path under the name): it stops
 * being routed — the name's other apps keep theirs — and a name nothing else
 * answers on loses its record here. The last binding stays: an app with none
 * is nothing anyone can reach.
 */
router.delete('/:id/domains/:host', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({
      where: { id: req.params.id as string, ...(await appScope(req)) },
      include: withDomains,
    });
    if (!application) return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);

    const host = normalizeHost(req.params.host);
    const at = normalizeBindingPath(req.query.path) ?? '';
    const label = `${host}${at}`;
    const name = application.domains.find((d) => d.host === host && d.path === at);
    if (!name) return res.status(404).json({ success: false, error: `${label} is not one of this app's names` } as ApiResponse);
    const needed = at ? [] : redirectsTo(application.domains, host);
    if (needed.length) return res.status(400).json({ success: false, error: `${needed.join(', ')} redirect to ${host} — remove or change them first` } as ApiResponse);
    // its last one may go too — asked first, said on the form: an app with no host is one
    // nobody reaches, a state it already has before its first host is added

    const node = await serverForApplication(application.id).catch(() => null);
    const removed = await prisma.appDomain.delete({ where: { host_path: { host, path: at } } });
    // the name's route without this binding: gone if nothing else is on it, the others' otherwise
    try {
      if (node) await recomposeHosts(node, [host]);
    } catch (error: any) {
      // not routed as it should be: the binding stays, nothing half-done
      await prisma.appDomain.create({ data: removed });
      return res.status(502).json({ success: false, error: `${label} could not be taken off: ${error?.message ?? error}` } as ApiResponse);
    }
    // its DNS record only when nothing answers on the name any more
    if (!(await prisma.appDomain.count({ where: { host } }))) {
      await removeAppHostname({ id: application.id, domain: host, domainId: name.domainId });
    }
    await prisma.log.create({
      data: { level: 'INFO', message: `${label} removed from ${application.name}`, userId: req.user!.userId, applicationId: application.id },
    });
    return res.json({ success: true, data: { host, path: at }, message: `${label} removed` } as ApiResponse);
  } catch (error: any) {
    console.error('Error removing a binding:', error);
    return res.status(502).json({ success: false, error: error?.message || 'Could not remove the binding' } as ApiResponse);
  }
});

/**
 * Build and restart an imported pm2 app in its folder on its server: install,
 * build, `pm2 restart` (pm2DeployService). The site can err while it builds —
 * there is no release folder beside it — so only on an explicit yes, and only
 * by its organization's owner or admin. Answers with the deployment row; the
 * steps carry on in the background and write their log onto it.
 */
router.post('/:id/pm2-deploy', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({
      where: { id: req.params.id as string, ...(await appScope(req)) },
      select: { id: true, organizationId: true },
    });
    if (!application) return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    const allowed = isPlatformAdmin(req) || (!!application.organizationId && (await canManageOrg(req, application.organizationId)));
    if (!allowed) {
      return res.status(403).json({ success: false, error: "Only the workspace's owner or an admin can build and restart it" } as ApiResponse);
    }
    if (req.body?.consent !== true) {
      return res.status(400).json({ success: false, error: 'Confirm that the site may err while it builds' } as ApiResponse);
    }
    const deploymentId = await startPm2Deploy(application.id, req.user!.userId);
    return res.status(202).json({ success: true, data: { deploymentId }, message: 'Building' } as ApiResponse);
  } catch (error: any) {
    if (error instanceof Pm2DeployError) return res.status(409).json({ success: false, error: error.message } as ApiResponse);
    console.error('Error starting a pm2 build:', error);
    return res.status(502).json({ success: false, error: error?.message || 'Could not start the build' } as ApiResponse);
  }
});

// What deleting an imported app could remove from its server — for the delete dialog
router.get('/:id/teardown', authenticateToken, requireRole([]), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({ where: { id: req.params.id as string, ...(await appScope(req)) }, include: withDomains });
    if (!application) {
      return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    }
    return res.json({ success: true, data: await teardownPlan(application) } as ApiResponse);
  } catch (error) {
    console.error('Error building teardown plan:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/**
 * Switch an app off in the panel, or back on. Nothing on the server changes:
 * it only stops being checked and moves to the bottom of the list — for a site
 * that is dead on purpose and should neither be deleted nor shout.
 */
router.post('/:id/disabled', authenticateToken, requireRole(['ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({ where: { id: req.params.id as string, ...(await appScope(req)) } });
    if (!application) return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);

    const disabled = req.body?.disabled === true;
    await prisma.application.update({ where: { id: application.id }, data: { disabled } });
    return res.json({ success: true, data: { disabled }, message: disabled ? 'Application disabled' : 'Application enabled' } as ApiResponse);
  } catch (error) {
    console.error('Error toggling application:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

// Is the imported app's folder really on its server — the row can say one that is not
router.get('/:id/folder', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({ where: { id: req.params.id as string, ...(await appScope(req)) } });
    if (!application) {
      return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    }
    const server = application.rootPath && application.serverId
      ? await prisma.server.findUnique({ where: { id: application.serverId } })
      : null;
    const exists = server ? await folderExists(server, application.rootPath!) : null;
    return res.json({ success: true, data: { path: application.rootPath, exists } } as ApiResponse);
  } catch (error) {
    console.error('Error checking app folder:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/**
 * A deleted app's files: its tree (releases, current, run.sh, logs). The project's
 * checkout, a sibling of it, goes with the project's last app.
 */
async function removeAppFiles(application: { id: string; sourceId: string | null }): Promise<void> {
  const afs = await appFsFor(application.id).catch(() => null);
  if (!afs) return;
  const rm = (p: string) => afs.rm(p, { recursive: true, force: true }).catch(() => {});
  await rm(afs.appDir);
  const others = application.sourceId
    ? await prisma.application.count({ where: { sourceId: application.sourceId, id: { not: application.id } } })
    : 0;
  const checkoutTree = path.posix.dirname(afs.sourcesDir);
  if (others === 0 && checkoutTree !== afs.appDir) await rm(checkoutTree);
}

// Delete an application
router.delete('/:id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    console.log('Delete application request:', {
      params: req.params,
      url: req.url,
      method: req.method
    });

    const { id } = req.params || {};

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    // Check if application exists and belongs to user
    const application = await prisma.application.findFirst({
      where: {
        id,
        ...(await appScope(req)),
      },
      include: { organization: { select: { slug: true } }, source: { select: { organizationId: true, createdById: true } }, ...withDomains },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }
    if (!application.runtime && !(await canManageProject(req, application.source ?? { organizationId: application.organizationId, createdById: null }))) {
      return res.status(403).json({ success: false, error: 'Only the creator of the project and the admins of its workspace can delete it' } as ApiResponse);
    }

    // Imported apps (runtime set) were set up by hand. Deleting one removes it
    // from the server too, all of it or nothing: anything that cannot be removed
    // refuses the delete, and a failed step keeps the row so the user sees what is left.
    if (application.runtime) {
      if (req.user?.role !== 'SUPERADMIN') {
        return res.status(403).json({ success: false, error: 'Only a superadmin can delete an app that was set up on the server' } as ApiResponse);
      }
      let result;
      try {
        result = await teardownApp(application);
      } catch (error: any) {
        return res.status(409).json({ success: false, error: `Not deleted: ${error?.message || 'something cannot be removed'}` } as ApiResponse);
      }
      if (result.failed) {
        return res.status(502).json({
          success: false,
          data: result,
          error: `Stopped at "${result.failed.step}": ${result.failed.error}. The app was not deleted.`,
        } as ApiResponse);
      }
    }

    // Tear down what the deploy created: the unit, the site config, the files.
    if (!application.runtime) {
      if (compose.needsCompose(application.type)) {
        // Volumes are a compose app's database, and an app is deleted far more
        // often than its data is meant to be — so they go only when asked.
        // A stack that did not come down keeps the row: without it (and its files,
        // removed below) nothing would ever find those containers again.
        try {
          await compose.removeApplication(application, { volumes: req.body?.removeVolumes === true });
        } catch (error: any) {
          console.error(`Failed to take down the stack for ${application.name}:`, error);
          return res.status(502).json({
            success: false,
            error: `Could not take down the containers: ${error?.message || 'compose down failed'}. The app was not deleted.`,
          } as ApiResponse);
        }
      }
      await systemd.removeApplication(application).catch((error) => {
        console.error(`Failed to remove unit for ${application.name}:`, error);
      });
      // its names' routes without it — the other apps on a shared name keep theirs
      await recomposeHosts(await serverForApplication(application.id), hostsOf(application), { without: application.id }).catch(() => {});
      const alone = await hostsOnlyOf(application.id, hostsOf(application));
      for (const at of atEach(application)) if (alone.includes(at.domain)) await removeAppHostname(at);
      // every release of a static site — the bucket is public, and nothing
      // would ever clean these up once the row is gone
      if (application.type === 'STATIC' && application.staticBucket) {
        await deleteAllSiteFiles(application.staticBucket).catch((error: any) =>
          console.error(`Could not delete the site files of ${application.name}:`, error?.message),
        );
      }
      await removeAppFiles(application);
    }

    // Its databases outlive it (onDelete: SetNull). One that only knew its org
    // through the app would drop out of every org's view — pin the org first.
    if (application.organizationId) {
      await prisma.database.updateMany({
        where: { applicationId: id, organizationId: null },
        data: { organizationId: application.organizationId },
      });
    }

    // Delete application; its health history is keyed by id, not a foreign key
    await prisma.application.delete({
      where: { id },
    });
    // its source goes with its last app, and the releases with the source
    await dropOrphanSources();
    await prisma.heartbeat.deleteMany({ where: { targetType: 'APPLICATION', targetId: id } });

    return res.json({
      success: true,
      message: 'Application deleted successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error deleting application:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Start existing application (without redeploying)
router.post('/:id/start-existing', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    console.log('Start existing application request:', {
      params: req.params,
      url: req.url,
      method: req.method
    });

    const { id } = req.params || {};

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    // Get application
    const application = await prisma.application.findFirst({
      where: {
        id,
        ...(await appScope(req)),
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    const pm2Handled = await handlePm2Action(application, 'start', res);
    if (pm2Handled) return pm2Handled;

    if (application.status === 'RUNNING') {
      return res.status(400).json({
        success: false,
        error: 'Application is already running',
      } as ApiResponse);
    }

    await prisma.application.update({
      where: { id },
      data: { status: 'DEPLOYING' },
    });

    // Start the existing unit without redeploying
    const started = await deploymentService.startApplication(application.id);

    if (started) {
      await prisma.application.update({
        where: { id },
        data: { status: 'RUNNING' },
      });

      return res.json({
        success: true,
        message: 'Application started successfully',
      } as ApiResponse);
    } else {
      await prisma.application.update({
        where: { id },
        data: { status: 'ERROR' },
      });

      return res.status(500).json({
        success: false,
        error: 'Failed to start application',
      } as ApiResponse);
    }
  } catch (error) {
    console.error('Error starting existing application:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Start application (with redeploy)
router.post('/:id/start', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    console.log('Start application request:', {
      params: req.params,
      url: req.url,
      method: req.method
    });

    const { id } = req.params || {};

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    // Get application
    const application = await prisma.application.findFirst({
      where: {
        id,
        ...(await appScope(req)),
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    const imported = refuseImported(application, res);
    if (imported) return imported;

    // resolveMigration: a Prisma migration recorded as failed (P3009), cleared before this deploy's migrations
    const resolveMigration = typeof req.body?.resolveMigration === 'string' ? req.body.resolveMigration.trim() : '';
    if (resolveMigration && !/^\d{14}_[A-Za-z0-9_-]{1,200}$/.test(resolveMigration)) {
      return res.status(400).json({ success: false, error: 'Not a migration name' } as ApiResponse);
    }
    // resetDatabase: the app's databases emptied first (after a snapshot) — the UI has the person type the app's name
    const launched = await launchDeploy(application, req.user!.userId, {
      resolveMigration: resolveMigration || undefined,
      // applied: a baseline — the migration's tables are already there, only its record is missing
      ...(resolveMigration && req.body?.resolveAs === 'applied' && { resolveAs: 'applied' as const }),
      ...(req.body?.resetDatabase === true && { resetDatabase: true }),
      // skipPreDeploy: the code alone, the migrations left for a later deploy
      ...(req.body?.skipPreDeploy === true && { skipPreDeploy: true }),
      // acceptDataLoss: `prisma db push` goes ahead where it would drop data — the UI confirms it
      ...(req.body?.acceptDataLoss === true && { acceptDataLoss: true }),
    });
    if (!launched) {
      return res.status(409).json({
        success: false,
        error: 'A deployment is already in progress',
      } as ApiResponse);
    }

    return res.json({
      success: true,
      data: { deploymentId: launched.deploymentId },
      message: 'Application deployment started',
    } as ApiResponse);
  } catch (error) {
    console.error('Error starting application:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Stop application
/** What the app's tree on its node costs: releases (live / rollback / unused), build cache, logs. */
router.get('/:id/disk', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({
      where: { id: req.params.id as string, ...(await appScope(req)) },
      select: { id: true },
    });
    if (!application) return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    const disk = await appDiskUsage(application.id);
    // the Storage card's Refresh is also "measure now" for the project list
    if (disk) await prisma.application.update({ where: { id: application.id }, data: { diskBytes: BigInt(disk.totalBytes), diskMeasuredAt: new Date() } });
    else void measureAppDisk(application.id).catch(() => {});
    return res.json({ success: true, data: disk } as ApiResponse);
  } catch (error: any) {
    console.error('Error reading app disk usage:', error);
    return res.status(502).json({ success: false, error: error?.message || 'Could not read the disk usage' } as ApiResponse);
  }
});

/**
 * Give back what the app does not need: unused releases, and with `cache` the
 * Next build cache (the next build is slower). Never the live release, never
 * one inside the rollback window. Refused while a deploy runs — it may be
 * writing the very tree that looks unused.
 */
router.post('/:id/cleanup', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({
      where: { id: req.params.id as string, ...(await appScope(req)) },
    });
    if (!application) return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    const imported = refuseImported(application, res);
    if (imported) return imported;
    if (deploymentService.isDeploying(application)) {
      return res.status(409).json({ success: false, error: 'A deployment is running — clean up once it has finished' } as ApiResponse);
    }

    const result = await cleanupApp(application.id, { cache: req.body?.cache === true });
    if (!result) return res.status(400).json({ success: false, error: 'This app keeps no files on a server' } as ApiResponse);
    await prisma.log.create({
      data: {
        level: 'INFO',
        message: `Cleaned up ${application.name}: ${result.removed.join(', ') || 'nothing to remove'}`,
        userId: req.user!.userId,
        applicationId: application.id,
      },
    });
    return res.json({ success: true, data: result } as ApiResponse);
  } catch (error: any) {
    console.error('Error cleaning up app:', error);
    return res.status(502).json({ success: false, error: error?.message || 'Could not clean up' } as ApiResponse);
  }
});

/**
 * The services a compose stack defines, read on its node by `compose config`
 * from the code there (the live release, or the checkout pulled at create) —
 * so the service and port Caddy proxies to are picked from a list, not guessed.
 */
router.get('/:id/compose/services', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({
      where: { id: req.params.id as string, ...(await appScope(req)) },
      include: { organization: { select: { slug: true } } },
    });
    if (!application) return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    if (!compose.needsCompose(application.type)) {
      return res.status(400).json({ success: false, error: 'This is not a compose app' } as ApiResponse);
    }
    return res.json({ success: true, data: await compose.previewStack(application) } as ApiResponse);
  } catch (error: any) {
    // compose's own complaint (a missing file, bad YAML) is the useful part
    return res.status(502).json({
      success: false,
      error: String(error?.stderr || error?.message || error).trim().slice(0, 500),
    } as ApiResponse);
  }
});

/**
 * Run one command inside a service of a compose stack — `ckan user add`, a
 * migration, a seed. These apps are administered through their own CLI, and
 * without this the panel knows about them without being able to work on them.
 *
 * Deliberately narrow: a fixed `compose exec <service> <argv>`, argv as a list
 * so it reaches a real exec rather than a shell, no TTY, no session, and no
 * other podman subcommand. Org admins and above, and every call is logged.
 */
router.post('/:id/exec', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({
      where: { id: req.params.id as string, ...(await appScope(req)) },
      include: { organization: { select: { slug: true } } },
    });
    if (!application) return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    if (!compose.needsCompose(application.type)) {
      return res.status(400).json({ success: false, error: 'This is not a compose app' } as ApiResponse);
    }
    if (!application.organizationId || !(await canManageOrg(req, application.organizationId))) {
      return res.status(403).json({ success: false, error: 'Only a workspace admin can run commands in a stack' } as ApiResponse);
    }

    const argv = Array.isArray(req.body?.argv) ? req.body.argv.map(String) : null;
    if (!argv || argv.length === 0) {
      return res.status(400).json({ success: false, error: 'argv is the command to run, as a list of strings' } as ApiResponse);
    }
    if (argv.some((arg: string) => arg.includes('\0'))) {
      return res.status(400).json({ success: false, error: 'argv may not contain NUL bytes' } as ApiResponse);
    }
    const service = typeof req.body?.service === 'string' && req.body.service ? req.body.service : null;
    if (service && !/^[A-Za-z0-9._-]{1,63}$/.test(service)) {
      return res.status(400).json({ success: false, error: 'invalid service name' } as ApiResponse);
    }

    await prisma.log.create({
      data: {
        level: 'INFO',
        // the command, not its output: output can carry whatever the stack prints
        message: `exec in ${application.name}${service ? ` (${service})` : ''}: ${argv.join(' ')}`,
        userId: req.user!.userId,
        applicationId: application.id,
      },
    });

    const result = await compose.execInService(application, service, argv);
    return res.json({ success: true, data: { stdout: result.stdout, stderr: result.stderr } } as ApiResponse);
  } catch (error: any) {
    // a non-zero exit is the command's answer, not a server fault
    const code = typeof error?.code === 'number' ? error.code : null;
    if (code !== null) {
      return res.status(422).json({
        success: false,
        error: `Exited ${code}`,
        data: { stdout: error?.stdout ?? '', stderr: error?.stderr ?? '', code },
      } as ApiResponse);
    }
    console.error('Error running a command in a stack:', error?.message);
    return res.status(502).json({ success: false, error: error?.message || 'Could not run the command' } as ApiResponse);
  }
});

/**
 * Stop the deploy that is running. It ends as CANCELLED shortly after — the
 * build on the node is stopped, and a deploy between steps stops at the next
 * one. What served before keeps serving. 409 when nothing is deploying.
 */
router.post('/:id/deploy/cancel', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({
      where: { id: req.params.id as string, ...(await appScope(req)) },
    });
    if (!application) return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    const imported = refuseImported(application, res);
    if (imported) return imported;

    if (!(await deploymentService.cancelDeploy(application.id))) {
      return res.status(409).json({ success: false, error: 'No deployment is running for this app' } as ApiResponse);
    }
    await prisma.log.create({
      data: { level: 'INFO', message: `Deployment of ${application.name} cancelled`, userId: req.user!.userId, applicationId: application.id },
    });
    return res.json({ success: true, message: 'Cancelling the deployment' } as ApiResponse);
  } catch (error) {
    console.error('Error cancelling deployment:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

router.post('/:id/stop', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    // Get application
    const application = await prisma.application.findFirst({
      where: {
        id,
        ...(await appScope(req)),
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    const pm2Handled = await handlePm2Action(application, 'stop', res);
    if (pm2Handled) return pm2Handled;

    if (application.status !== 'RUNNING') {
      return res.status(400).json({
        success: false,
        error: 'Application is not running',
      } as ApiResponse);
    }

    const stopped = await deploymentService.stopApplication(application.id);

    if (stopped) {
      await prisma.application.update({
        where: { id },
        data: { status: 'STOPPED' },
      });

      return res.json({
        success: true,
        message: 'Application stopped successfully',
      } as ApiResponse);
    } else {
      return res.status(500).json({
        success: false,
        error: 'Failed to stop application',
      } as ApiResponse);
    }
  } catch (error) {
    console.error('Error stopping application:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Restart application
router.post('/:id/restart', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    // Get application
    const application = await prisma.application.findFirst({
      where: {
        id,
        ...(await appScope(req)),
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    const pm2Handled = await handlePm2Action(application, 'restart', res);
    if (pm2Handled) return pm2Handled;
    // check if application is running
    const status = await deploymentService.getApplicationStatus(application.id);
    if (status === 'STOPPED') {
      //update application status to running
      await prisma.application.update({
        where: { id },
        data: { status: 'STOPPED' },
      });
      return res.json({
        success: false,
        error: 'Application is not running',
      } as ApiResponse);
    }
    const restarted = await deploymentService.restartApplication(application.id);

    if (restarted) {
      await prisma.application.update({
        where: { id },
        data: { status: 'RUNNING' },
      });

      return res.json({
        success: true,
        message: 'Application restarted successfully',
      } as ApiResponse);
    } else {
      return res.status(500).json({
        success: false,
        error: 'Failed to restart application',
      } as ApiResponse);
    }
  } catch (error) {
    console.error('Error restarting application:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// List releases for an application
/**
 * Is the hostname actually serving? Checked live rather than stored: DNS and
 * certificates change without anything telling us, and a cached answer would
 * be exactly the lie this is here to catch.
 */
router.get('/:id/hostname', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({
      where: { id: req.params.id as string, ...(await appScope(req)) },
      include: withDomains,
    });

    if (!application) {
      return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    }

    // each of its bindings on its own, at its own path: one can answer while another does not
    const data = await Promise.all(
      application.domains.map(async (binding) => {
        const at = { id: application.id, domain: binding.host, domainId: binding.domainId };
        // the registration too: an expired domain often still resolves — to the registrar's parking page
        const [health, managed, registration, pointing] = await Promise.all([
          checkAppHostname(at.domain, 5000, healthPath(binding.path)),
          dnsManaged(at),
          hostnameRegistration(at.domain).catch(() => null),
          // does the name lead to the server this app runs on — or somewhere else that happens to answer
          whereHostnamePoints(at).catch(() => null),
        ]);
        return {
          ...health,
          path: binding.path,
          dnsManaged: managed,
          domainProblem: registration?.problem ?? null,
          registeredDomain: registration?.domain ?? null,
          pointing,
        };
      }),
    );
    return res.json({ success: true, data } as ApiResponse);
  } catch (error) {
    console.error('Error checking application hostname:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/** Create or repoint the DNS record of one of the app's names (`host`). `force` overwrites a conflicting one. */
router.post('/:id/dns', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({
      where: { id: req.params.id as string, ...(await appScope(req)) },
      include: withDomains,
    });

    if (!application) {
      return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    }
    // which name: the one asked for — an app of one name needs no asking
    const names = atEach(application);
    const at = req.body?.host ? names.find((name) => name.domain === normalizeHost(req.body.host)) : names.length === 1 ? names[0] : undefined;
    if (!at) return res.status(400).json({ success: false, error: 'Say which of its hostnames' } as ApiResponse);

    // force = the user confirmed the repoint dialog, which showed what is replaced
    const result = await applyAppDns(req, at, req.body?.force === true);
    // the record just moved: what the hostname check remembered about it is stale
    forgetPointing(application.id);

    return res.json({
      success: result.state !== 'conflict' && result.state !== 'unavailable',
      data: result,
      ...(result.state === 'conflict' || result.state === 'unavailable'
        ? { error: result.detail }
        : { message: result.detail }),
    } as ApiResponse);
  } catch (error: any) {
    console.error('Error setting application DNS:', error);
    return res.status(502).json({
      success: false,
      error: error?.message || 'Could not set up DNS for this hostname',
    } as ApiResponse);
  }
});

/**
 * HTTPS for the app's names without a redeploy: Caddy made to listen on :443,
 * then a certificate for each name that has none (Cloudflare proxy off, Caddy
 * reloaded, proxy back on). Minutes of work: started here, the outcome in the Log.
 */
router.post('/:id/ssl', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({
      where: { id: req.params.id as string, ...(await appScope(req)) },
      include: withDomains,
    });
    if (!application) return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    const hosts = atEach(application).map((name) => name.domain);
    if (hosts.length === 0) return res.status(400).json({ success: false, error: 'This service has no hostname' } as ApiResponse);

    const node = await serverForApplication(application.id);
    if (!provisionInBackground(node, hosts, req.user!.userId)) {
      return res.status(409).json({ success: false, error: 'Certificates are already being provisioned on this server — try again in a few minutes' } as ApiResponse);
    }
    forgetPointing(application.id);
    return res.json({ success: true, message: `Getting HTTPS ready for ${hosts.join(', ')}` } as ApiResponse);
  } catch (error: any) {
    console.error('Error provisioning application SSL:', error);
    return res.status(502).json({ success: false, error: error?.message || 'Could not start' } as ApiResponse);
  }
});

router.get('/:id/releases', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    const application = await prisma.application.findFirst({
      where: {
        id,
        ...(await appScope(req)),
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    const releases = await prisma.release.findMany({
      where: { applicationId: application.id },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({
      success: true,
      data: {
        applicationId: application.id,
        activeReleaseId: application.activeReleaseId ?? null,
        releases,
      },
      message: 'Releases retrieved successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error fetching releases:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Activate a specific release (rollback)
router.post('/:id/releases/:releaseId/activate', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id, releaseId } = req.params;

    if (!id || !releaseId) {
      return res.status(400).json({
        success: false,
        error: 'Application ID and Release ID are required',
      } as ApiResponse);
    }

    const application = await prisma.application.findFirst({
      where: {
        id,
        ...(await appScope(req)),
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    const imported = refuseImported(application, res);
    if (imported) return imported;

    const release = await prisma.release.findFirst({ where: { id: releaseId, applicationId: application.id } });

    if (!release) {
      return res.status(404).json({
        success: false,
        error: 'Release not found',
      } as ApiResponse);
    }

    if (release.status !== 'READY') {
      return res.status(400).json({
        success: false,
        error: 'Release is not in READY state',
      } as ApiResponse);
    }

    // A static release is a folder in R2: switching is moving the route to it.
    // Nothing stops, nothing is uploaded again.
    if (application.type === 'STATIC') {
      if (!application.staticOrigin) {
        return res.status(400).json({ success: false, error: 'This site has nothing published yet' } as ApiResponse);
      }
      const staticOrigin = inFolder(siteRootOrigin(application.staticOrigin), release.path ?? '');
      try {
        await serveStatic(await serverForApplication(application.id), application.id, staticOrigin);
      } catch (error: any) {
        // the route did not move, so the previous release is still what serves
        return res.status(502).json({ success: false, error: staticRouteError(error) } as ApiResponse);
      }

      await prisma.application.update({
        where: { id: application.id },
        data: { staticOrigin, activeReleaseId: release.id, status: 'RUNNING', lastDeployment: new Date() },
      });
      // in the history too: "what changed at 14:02" should find the rollback
      await prisma.deployment.create({
        data: {
          applicationId: application.id,
          sourceId: application.sourceId,
          userId: req.user!.userId,
          status: 'SUCCESS',
          commitHash: release.commitSha,
          deployLogs: `Switched to the release from ${release.createdAt.toISOString()} (${release.path || 'site root'})`,
        },
      });

      return res.json({
        success: true,
        data: { applicationId: application.id, activeReleaseId: release.id },
        message: 'Release activated',
      } as ApiResponse);
    }

    await deploymentService.stopApplication(application.id);
    const started = await deploymentService.startRelease(application, release);

    await prisma.application.update({
      where: { id: application.id },
      data: {
        activeReleaseId: release.id,
        status: started ? 'RUNNING' : 'ERROR',
        lastDeployment: new Date(),
      },
    });
    // in the history too, like a static switch
    await prisma.deployment.create({
      data: {
        applicationId: application.id,
        sourceId: application.sourceId,
        userId: req.user!.userId,
        status: started ? 'SUCCESS' : 'FAILED',
        commitHash: release.commitSha,
        deployLogs: started
          ? `Switched to the release from ${release.createdAt.toISOString()}`
          : `Switched to the release from ${release.createdAt.toISOString()}, but it did not start`,
      },
    });

    if (!started) {
      return res.status(500).json({
        success: false,
        error: 'Failed to start the selected release',
      } as ApiResponse);
    }

    return res.json({
      success: true,
      data: {
        applicationId: application.id,
        activeReleaseId: release.id,
      },
      message: 'Release activated successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error activating release:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

export default router; 
