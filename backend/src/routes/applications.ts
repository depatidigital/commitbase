import { Router, Request, Response } from 'express';
import { AppType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { CreateApplicationSchema, UpdateApplicationSchema, ApiResponse, Application, PaginatedResponse } from '../types';
import { validateRequest } from '../middleware/validation';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { paging, contains } from '../lib/paging';
import { orgScope } from '../lib/scope';
import { applyAppDns, inspectHost, normalizeHost, resolveAppHost, sharedHostTaken } from '../lib/appHostname';
import { DeploymentService } from '../services/deployment';
import { getStaticSiteBaseUrl } from '../services/s3Service';
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
import { configureCaddyForStaticApplication, removeCaddySite, staticRouteError } from '../services/caddyService';
import { appDiskUsage, cleanupApp } from '../services/appDiskService';
import { ensureAppHostname, removeAppHostname, checkAppHostname, dnsManaged, whereHostnamePoints } from '../services/appDnsService';
import { serverForApplication } from '../lib/servers';
import { forgetPointing, healthFor } from '../services/heartbeatService';
import * as systemd from '../services/systemdService';
import { appFsFor, sourceFsFor } from '../lib/appFs';
import { cleanRootDirectory, inRootDirectory, ROOT_DIRECTORY_RE, sourceDirOf } from '../lib/appPaths';
import { queueOrgNode } from '../services/orgProvisionService';
import { detectFromFiles, detectFromRepo, detectProject, listRemoteBranches, parseLsRemote, presenceOnly, DETECT_FILES, DetectInput } from '../lib/projectDetect';
import { exec } from '../lib/runner';
import { gitAuthFor, providerOf } from '../lib/gitCredentials';
import { getGitOAuthConfig } from '../services/integrationConfigService';
import { readEnv, sealEnv } from '../lib/appEnv';
import { createApplicationWithSource, dropOrphanSources, setSourceOrganization, withSourceFields } from '../lib/sources';
import { launchDeploy } from '../services/deployLaunch';
import { syncServerApps, scanServerApps, controlPm2Process } from '../services/appSyncService';
import { healCaddyRoutes, snapshotCaddyConfig, restoreCaddyConfig } from '../services/caddySnapshotService';
import { requireRole } from '../middleware/auth';
import { folderExists, teardownApp, teardownPlan } from '../services/appTeardownService';
import { hostnameRegistration } from '../services/rdapService';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';

const router = Router();
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
      const source = await prisma.source.findFirst({ where: { id: String(req.body.sourceId), ...(await orgScope(req)) } });
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
 * What an existing app's code looks like right now: commands, the env keys its
 * .env.example expects, whether it wants a database. Read from the repository
 * (through the app's git account) or from uploaded sources — never stored, so
 * the setup page always reflects the branch as it is.
 */
router.get('/:id/detect', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({
      where: { id: req.params.id as string, ...(await orgScope(req)) },
      select: { id: true, rootDirectory: true, source: { select: { repository: true, branch: true, gitAccountId: true } } },
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
          const sources = path.posix.join(afs.appDir, 'sources');
          return detectProject(inRootDirectory(sources, application.rootDirectory), afs.readText, undefined, sources);
        })();

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
      ...(await orgScope(req)),
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
        return res.status(404).json({ success: false, error: 'Organization not found' } as ApiResponse);
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
      where: { id: { in: ids }, ...(await orgScope(req)) },
      select: { id: true },
    });

    return res.json({
      success: true,
      data: await healthFor('APPLICATION', visible.map((app) => app.id)),
    } as ApiResponse);
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
        ...(await orgScope(req)),
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

    // R2 sites are served on their own hostname. Only a site that was deployed
    // before R2 (deployed, but no bucket origin) still lives at the old S3
    // prefix — a never-uploaded one has no URL at all.
    const staticSiteUrl =
      application.type === 'STATIC'
        ? (application as any).staticOrigin
          ? `https://${application.domains[0]?.host}`
          : application.lastDeployment
            ? getStaticSiteBaseUrl(application.id)
            : null
        : undefined;

    return res.json({
      success: true,
      data: {
        ...withSourceFields(application),
        // the detail page edits them; everywhere else only the sealed blob goes out
        envVars: readEnv(application.envVars),
        staticSiteUrl,
        placement: application.server ?? application.organization?.defaultServer ?? null,
      },
      message: 'Application retrieved successfully',
    } as ApiResponse<Application & { staticSiteUrl?: string | null }>);
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
    const domain = normalizeHost(req.body.domain);
    const rootDirectory = cleanRootDirectory(req.body.rootDirectory);

    if (!(await assertOwnGitAccount(gitAccountId, req.user!.userId, res))) return;

    // An app added to an existing project ("Tambah Aplikasi"): no source of its
    // own — it builds with the project's other apps, from the same commit, so it
    // runs on the project's node and belongs to the project's organization.
    const joining = req.body.sourceId
      ? await prisma.source.findFirst({
          where: { id: String(req.body.sourceId), ...(await orgScope(req)) },
          include: { applications: { select: { type: true } } },
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
      if (type === 'STATIC' || joining.applications.some((app) => app.type === 'STATIC')) {
        return res.status(400).json({ success: false, error: 'A static site cannot share its project with other apps yet' } as ApiResponse);
      }
      if (!joining.serverId) {
        return res.status(409).json({ success: false, error: 'This project has no server yet — deploy it once first' } as ApiResponse);
      }
    }

    // Check if domain already exists
    // an alias of another app is taken as much as its main hostname
    const existingApp = await prisma.application.findFirst({
      where: { OR: [{ domain }, { aliases: { has: domain } }] },
    });

    if (existingApp) {
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
    const { parent: parentDomain, organizationId } = resolved;
    if (joining?.organizationId && organizationId !== joining.organizationId) {
      return res.status(403).json({
        success: false,
        error: "That domain belongs to another organization — pick one of this project's organization",
      } as ApiResponse);
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
    const serverId = requested ?? org?.defaultServerId ?? null;
    if (!serverId) {
      return res.status(400).json({
        success: false,
        error: "No server for this app — pick one, or ask an administrator to set the organization's default server.",
      } as ApiResponse);
    }

    const node = await prisma.server.findUnique({ where: { id: serverId } });
    if (!node) {
      return res.status(400).json({ success: false, error: 'Unknown server' } as ApiResponse);
    }
    const taken = await sharedHostTaken(parentDomain, domain, node);
    if (taken) {
      return res.status(409).json({ success: false, error: taken } as ApiResponse);
    }

    const fields = {
      name,
      domain,
      type,
      rootDirectory,
      installCommand,
      buildCommand,
      preDeployCommand,
      startCommand,
      port,
      ...(envVars && { envVars: sealEnv(envVars) }),
      userId: req.user!.userId,
      domainId: parentDomain.id,
      organizationId,
      serverId,
    };
    const application = withSourceFields(
      joining
        ? await prisma.application.create({ data: { ...fields, sourceId: joining.id }, include: { source: true } })
        : await createApplicationWithSource(fields, { repository, gitAccountId, branch }),
    );

    // Provision the org on that node now, so the first deploy does not wait
    // for it (the deploy still checks, and waits if this has not finished).
    // Static sites are served from R2 and never need the org's OS user.
    if (organizationId && serverId && type !== 'STATIC') {
      await queueOrgNode(organizationId, serverId, { userId: req.user!.userId, trigger: 'app-create' }).catch(
        (error) => console.error(`Could not queue provisioning for ${domain}:`, error),
      );
    }

    // Point the hostname at the platform now, so the app is reachable the
    // moment it deploys. A hostname already pointing somewhere else is left
    // alone and reported — the caller can retry with ?force=1.
    // dnsConsent: the user agreed on the form to replace what the name points at
    // (and to move a registrar domain to Cloudflare) — the form showed exactly what
    const consent = req.body.dnsConsent === true || req.query.force === '1';
    const dns = await applyAppDns(req, application, consent).catch(
      (error: any) => ({ state: 'unavailable' as const, detail: String(error?.message ?? 'DNS setup failed') }),
    );

    return res.status(201).json({
      success: true,
      data: { ...application, dns },
      message:
        dns.state === 'conflict' || dns.state === 'unavailable'
          ? `Application created, but DNS was not set up: ${dns.detail}`
          : 'Application created successfully',
    } as ApiResponse<Application>);
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
        where: { id: id as string, ...(await orgScope(req)) },
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
          data: { sourceId: application.sourceId, status: 'READY', path: folder, deploymentId: deployment.id },
        });
        const pointer = { staticBucket: bucket, staticOrigin: inFolder(origin, folder), source: { update: { activeReleaseId: release.id } } };

        try {
          await configureCaddyForStaticApplication(
            await serverForApplication(application.id),
            application.id,
            application.domain,
            pointer.staticOrigin,
          );
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
        const dns = await ensureAppHostname(application).catch(
          (error: any) => ({ state: 'unavailable' as const, detail: String(error?.message ?? 'DNS setup failed') }),
        );
        const dnsWarning =
          dns.state === 'conflict' || dns.state === 'unavailable' ? `\nDNS was not set up: ${dns.detail}` : '';

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
          data: { files: uploaded, dns },
          message:
            dns.state === 'conflict' || dns.state === 'unavailable'
              ? `Static files uploaded, but DNS was not set up: ${dns.detail}`
              : 'Static files uploaded to Cloudflare R2',
        } as ApiResponse);
      }

      // on the org's node when the app lives there (lib/appFs.ts)
      const afs = await deploymentService.prepareAppDirectory(application.id);
      const sourcesDir = path.posix.join(afs.appDir, 'sources');

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
    where: { id: req.params.id as string, ...(await orgScope(req)) },
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
    const { name, domain, type, repository, branch, installCommand, buildCommand, preDeployCommand, startCommand, port, envVars, gitAccountId, rootDirectory } =
      req.body || {};
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
        ...(await orgScope(req)),
      },
    });

    if (!existingApp) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    if (!(await assertOwnGitAccount(gitAccountId, req.user!.userId, res))) return;

    // Check if new domain conflicts with existing application
    let domainId: string | undefined;
    let organizationId: string | null | undefined;
    const normalizedDomain = domain ? normalizeHost(domain) : undefined;
    const renamed = !!normalizedDomain && normalizedDomain !== existingApp.domain;

    if (renamed) {
      // an imported app's route and files are someone else's config
      if (existingApp.runtime) {
        return res.status(400).json({ success: false, error: 'An imported app keeps its hostname' } as ApiResponse);
      }

      const domainConflict = await prisma.application.findFirst({
        where: { OR: [{ domain: normalizedDomain }, { aliases: { has: normalizedDomain } }] },
      });

      if (domainConflict) {
        return res.status(400).json({
          success: false,
          error: 'Domain already in use',
        } as ApiResponse);
      }

      // Same ownership boundary as create — and a rename never moves the app
      // to another org: that is an admin's reassignment, not a hostname change
      const resolved = await resolveAppHost(req, normalizedDomain, existingApp.organizationId);
      if ('error' in resolved) {
        return res.status(resolved.status).json({ success: false, error: resolved.error } as ApiResponse);
      }
      if (existingApp.organizationId && resolved.organizationId !== existingApp.organizationId) {
        return res.status(403).json({
          success: false,
          error: "That domain belongs to another organization — pick one of this app's organization",
        } as ApiResponse);
      }
      const taken = await sharedHostTaken(resolved.parent, normalizedDomain, await serverForApplication(existingApp.id));
      if (taken) {
        return res.status(409).json({ success: false, error: taken } as ApiResponse);
      }
      domainId = resolved.parent.id;
      organizationId = resolved.organizationId;
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
      include: { source: true },
      data: {
        name,
        ...(normalizedDomain && { domain: normalizedDomain }),
        ...(domainId && { domainId }),
        ...(organizationId !== undefined && { organizationId }),
        type,
        // '' / null: back to the repository root
        ...(rootDirectory !== undefined && { rootDirectory: cleanRootDirectory(rootDirectory) }),
        // '' clears back to the detected install / no pre-deploy step
        ...(installCommand !== undefined && { installCommand: installCommand.trim() || null }),
        buildCommand,
        ...(preDeployCommand !== undefined && { preDeployCommand: preDeployCommand.trim() || null }),
        startCommand,
        port,
        ...(envVars !== undefined && { envVars: sealEnv(envVars) }),
      },
    });

    // A new hostname is served before the old one stops: route the new name,
    // and only once that worked drop the old route and its DNS record. A
    // failed route puts the old name back, so the app is never unreachable.
    let dns: Awaited<ReturnType<typeof ensureAppHostname>> | undefined;
    if (renamed) {
      const node = await serverForApplication(existingApp.id);
      try {
        if (existingApp.status === 'RUNNING') {
          const withOrg = await prisma.application.findUniqueOrThrow({
            where: { id },
            include: { organization: { select: { slug: true } } },
          });
          await deploymentService.applyCaddyRoute(withOrg);
        }
      } catch (error: any) {
        await prisma.application.update({
          where: { id },
          data: { domain: existingApp.domain, domainId: existingApp.domainId, organizationId: existingApp.organizationId },
        });
        return res.status(502).json({
          success: false,
          error: `${normalizedDomain} could not be routed, so the app stays on ${existingApp.domain}: ${error?.message ?? error}`,
        } as ApiResponse);
      }
      await removeCaddySite(node, existingApp.domain).catch(() => {});
      await removeAppHostname(existingApp);
      dns = await applyAppDns(req, updatedApp, req.body?.dnsConsent === true).catch(
        (error: any) => ({ state: 'unavailable' as const, detail: String(error?.message ?? 'DNS setup failed') }),
      );
    }

    return res.json({
      success: true,
      data: { ...withSourceFields(updatedApp), envVars: readEnv(updatedApp.envVars), ...(dns && { dns }) },
      message:
        dns && (dns.state === 'conflict' || dns.state === 'unavailable')
          ? `Application updated, but DNS was not set up: ${dns.detail}`
          : 'Application updated successfully',
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

// What deleting an imported app could remove from its server — for the delete dialog
router.get('/:id/teardown', authenticateToken, requireRole([]), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({ where: { id: req.params.id as string, ...(await orgScope(req)) } });
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
    const application = await prisma.application.findFirst({ where: { id: req.params.id as string, ...(await orgScope(req)) } });
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
    const application = await prisma.application.findFirst({ where: { id: req.params.id as string, ...(await orgScope(req)) } });
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
 * A deleted app's files. Its source's tree (sources, releases, current) goes
 * with the source's last app; while other apps of it remain, only what is this
 * app's own does — and when the tree is in this app's directory (the source
 * shares its id), that is its run.sh, runtime env and unit logs, nothing else.
 */
async function removeAppFiles(application: { id: string; sourceId: string | null }): Promise<void> {
  const afs = await appFsFor(application.id).catch(() => null);
  if (!afs) return;
  const others = application.sourceId
    ? await prisma.application.count({ where: { sourceId: application.sourceId, id: { not: application.id } } })
    : 0;
  const rm = (p: string) => afs.rm(p, { recursive: true, force: true }).catch(() => {});
  const sourceDir = sourceDirOf(afs.appDir, application.sourceId);

  if (others === 0) {
    await rm(afs.appDir);
    if (sourceDir !== afs.appDir) await rm(sourceDir);
  } else if (sourceDir === afs.appDir) {
    for (const file of ['run.sh', '.env.runtime', 'logs/out.log', 'logs/error.log']) await rm(path.posix.join(afs.appDir, file));
  } else {
    await rm(afs.appDir);
  }
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
        ...(await orgScope(req)),
      },
      include: { organization: { select: { slug: true } } },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
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
      await systemd.removeApplication(application).catch((error) => {
        console.error(`Failed to remove unit for ${application.domain}:`, error);
      });
      await removeCaddySite(await serverForApplication(application.id), application.domain).catch(() => {});
      await removeAppHostname(application);
      // every release of a static site — the bucket is public, and nothing
      // would ever clean these up once the row is gone
      if (application.type === 'STATIC' && application.staticBucket) {
        await deleteAllSiteFiles(application.staticBucket).catch((error: any) =>
          console.error(`Could not delete the site files of ${application.domain}:`, error?.message),
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
        ...(await orgScope(req)),
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
    const started = await deploymentService.startApplication(application.domain);

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
        ...(await orgScope(req)),
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

    const launched = await launchDeploy(application, req.user!.userId);
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
      where: { id: req.params.id as string, ...(await orgScope(req)) },
      select: { id: true },
    });
    if (!application) return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    return res.json({ success: true, data: await appDiskUsage(application.id) } as ApiResponse);
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
      where: { id: req.params.id as string, ...(await orgScope(req)) },
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
        message: `Cleaned up ${application.domain}: ${result.removed.join(', ') || 'nothing to remove'}`,
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
 * Stop the deploy that is running. It ends as CANCELLED shortly after — the
 * build on the node is stopped, and a deploy between steps stops at the next
 * one. What served before keeps serving. 409 when nothing is deploying.
 */
router.post('/:id/deploy/cancel', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({
      where: { id: req.params.id as string, ...(await orgScope(req)) },
    });
    if (!application) return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    const imported = refuseImported(application, res);
    if (imported) return imported;

    if (!(await deploymentService.cancelDeploy(application.id))) {
      return res.status(409).json({ success: false, error: 'No deployment is running for this app' } as ApiResponse);
    }
    await prisma.log.create({
      data: { level: 'INFO', message: `Deployment of ${application.domain} cancelled`, userId: req.user!.userId, applicationId: application.id },
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
        ...(await orgScope(req)),
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

    const stopped = await deploymentService.stopApplication(application.domain);

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
        ...(await orgScope(req)),
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
    const status = await deploymentService.getApplicationStatus(application.domain);
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
    const restarted = await deploymentService.restartApplication(application.domain);

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
      where: { id: req.params.id as string, ...(await orgScope(req)) },
    });

    if (!application) {
      return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    }

    // the registration too: an expired domain often still resolves — to the registrar's parking page
    const [health, managed, registration, pointing] = await Promise.all([
      checkAppHostname(application.domain),
      dnsManaged(application),
      hostnameRegistration(application.domain).catch(() => null),
      // does the name lead to the server this app runs on — or somewhere else that happens to answer
      whereHostnamePoints(application).catch(() => null),
    ]);
    return res.json({
      success: true,
      data: {
        ...health,
        dnsManaged: managed,
        domainProblem: registration?.problem ?? null,
        registeredDomain: registration?.domain ?? null,
        pointing,
      },
    } as ApiResponse);
  } catch (error) {
    console.error('Error checking application hostname:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/** Create or repoint the app's DNS record. `force` overwrites a conflicting one. */
router.post('/:id/dns', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({
      where: { id: req.params.id as string, ...(await orgScope(req)) },
    });

    if (!application) {
      return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    }

    // force = the user confirmed the repoint dialog, which showed what is replaced
    const result = await applyAppDns(req, application, req.body?.force === true);
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
        ...(await orgScope(req)),
      },
      include: {
        source: { select: { activeReleaseId: true } },
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    const releases = application.sourceId
      ? await prisma.release.findMany({
          where: {
            sourceId: application.sourceId,
          },
          orderBy: {
            createdAt: 'desc',
          },
        })
      : [];

    return res.json({
      success: true,
      data: {
        applicationId: application.id,
        activeReleaseId: application.source?.activeReleaseId ?? null,
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
        ...(await orgScope(req)),
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

    const release = application.sourceId
      ? await prisma.release.findFirst({
          where: {
            id: releaseId,
            sourceId: application.sourceId,
          },
        })
      : null;

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
        await configureCaddyForStaticApplication(
          await serverForApplication(application.id),
          application.id,
          application.domain,
          staticOrigin,
        );
      } catch (error: any) {
        // the route did not move, so the previous release is still what serves
        return res.status(502).json({ success: false, error: staticRouteError(error) } as ApiResponse);
      }

      await prisma.application.update({
        where: { id: application.id },
        data: { staticOrigin, source: { update: { activeReleaseId: release.id } }, status: 'RUNNING', lastDeployment: new Date() },
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

    await prisma.source.update({
      where: { id: release.sourceId! },
      data: { activeReleaseId: release.id },
    });

    await deploymentService.stopApplication(application.domain);

    // every app of the source runs from the release just switched to
    const started = await deploymentService.startRelease(application, release);

    await prisma.application.updateMany({
      where: application.sourceId ? { sourceId: application.sourceId, runtime: null } : { id: application.id },
      data: {
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
