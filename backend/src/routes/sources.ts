import { Router, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { ApiResponse } from '../types';
import { authenticateToken, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { canManageOrg, orgScope, isPlatformAdmin } from '../lib/scope';
import { paging, contains } from '../lib/paging';
import { exec } from '../lib/runner';
import { gitAuthFor } from '../lib/gitCredentials';
import { listRemoteBranches, parseLsRemote } from '../lib/projectDetect';
import { isBranchName, setSourceOrganization, sourceName } from '../lib/sources';
import { launchDeploy } from '../services/deployLaunch';
import { buildProject, notOwner } from '../services/pm2DeployService';
import { DeploymentService } from '../services/deployment';
import { sourceFsFor } from '../lib/appFs';

const deploymentService = new DeploymentService();

/**
 * Sources — what the UI lists as "Proyek": a repository checkout or an upload,
 * and the apps ("Aplikasi") served from it. Pull and deploy happen here, once
 * for all of them; everything per hostname stays on /api/applications.
 */
const router: Router = Router();

const instanceSelect = {
  id: true,
  name: true,
  // every name it answers on, all alike
  domains: { select: { host: true, path: true, domainId: true }, orderBy: [{ host: 'asc' }, { path: 'asc' }] },
  type: true,
  status: true,
  runtime: true,
  disabled: true,
  processName: true,
  rootDirectory: true,
  rootPath: true,
  port: true,
  routing: true,
  createdAt: true,
} satisfies Prisma.ApplicationSelect;

type Instance = Prisma.ApplicationGetPayload<{ select: typeof instanceSelect }>;

/**
 * One status for the row, worst first: work in flight, then anything broken,
 * then stopped. Switched-off apps do not count unless all of them are. Pure.
 */
export function rollupStatus(apps: Array<Pick<Instance, 'status' | 'disabled'>>): string {
  const live = apps.filter((app) => !app.disabled);
  if (apps.length === 0) return 'EMPTY';
  if (live.length === 0) return 'DISABLED';
  const has = (status: string) => live.some((app) => app.status === status);
  if (has('DEPLOYING') || has('BUILDING')) return 'DEPLOYING';
  if (has('ERROR')) return 'ERROR';
  if (live.every((app) => app.status === 'RUNNING')) return 'RUNNING';
  return has('RUNNING') ? 'PARTIAL' : 'STOPPED';
}

/**
 * Imported sources are pulled on their server; the panel's own are deployed.
 * Imported = checked out on the server, or every app of it found there by the
 * sync (a proxied site whose folder was never detected has no path).
 */
const kindOf = (source: { path: string | null; applications: Array<{ runtime: string | null }> }) =>
  source.path || (source.applications.length > 0 && source.applications.every((app) => app.runtime)) ? 'IMPORTED' : 'MANAGED';

/** git in a checkout on its server. Never waits on a prompt: there is no tty. */
const checkoutGit = (server: Parameters<typeof exec>[0], dir: string, args: string[]) =>
  exec(
    server,
    ['env', 'GIT_TERMINAL_PROMPT=0', 'GIT_SSH_COMMAND=ssh -o BatchMode=yes', 'git', '-c', 'safe.directory=*', '-C', dir, ...args],
    { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
  );

/** Its organization's owner or admin (and the platform's admins) — the client decides which branch their site runs. */
const maySwitchBranch = async (req: AuthenticatedRequest, source: { organizationId: string | null }) =>
  isPlatformAdmin(req) || (!!source.organizationId && (await canManageOrg(req, source.organizationId)));

async function findSource(req: AuthenticatedRequest, res: Response) {
  const source = await prisma.source.findFirst({
    where: { id: req.params.id as string, ...(await orgScope(req)) },
    include: {
      organization: { select: { id: true, name: true, slug: true } },
      server: { select: { id: true, name: true, hostname: true, publicIp: true } },
      applications: {
        select: { ...instanceSelect, activeRelease: { select: { id: true, commitSha: true, createdAt: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!source) {
    res.status(404).json({ success: false, error: 'Project not found' } as ApiResponse);
    return null;
  }
  // What is live, for the project: its apps deploy on their own, so the oldest of
  // their live releases — the one furthest behind — is what the project stands on.
  const live = source.applications.map((app) => app.activeRelease).filter((r): r is NonNullable<typeof r> => !!r);
  const activeRelease = live.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null;
  return { ...source, activeRelease };
}

const present = <T extends { name: string | null; repository: string | null; path: string | null; applications: Instance[] }>(source: T) => ({
  ...source,
  name: sourceName(source, source.applications[0]?.domains[0]?.host),
  customName: source.name,
  kind: kindOf(source),
  status: rollupStatus(source.applications),
});

/**
 * Every source in scope, with its apps and last deploy or pull. Searching a
 * hostname finds the source it is served from.
 *
 * ponytail: sorted and paged in memory — names are derived and the status is a
 * rollup, neither is a column. Fine for hundreds of sources; a stored name and
 * status if it ever gets to thousands.
 */
router.get('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, limit, skip, search, organizationId } = paging(req);
    const serverId = String(req.query.serverId ?? '').trim();
    const where: Prisma.SourceWhereInput = {
      ...(await orgScope(req)),
      // ?organizationId=unassigned: what the sync found that nobody has claimed yet
      ...(organizationId && { organizationId: organizationId === 'unassigned' ? null : organizationId }),
      ...(serverId && { serverId }),
      ...(search && {
        OR: [
          { name: contains(search) },
          { repository: contains(search) },
          { path: contains(search) },
          { applications: { some: { OR: [{ domains: { some: { host: contains(search) } } }, { name: contains(search) }] } } },
        ],
      }),
      // a source is its apps; one without any is on its way out
      applications: { some: {} },
    };

    const sources = await prisma.source.findMany({
      where,
      include: {
        organization: { select: { id: true, name: true, slug: true } },
        server: { select: { id: true, name: true } },
        applications: { select: instanceSelect, orderBy: { createdAt: 'asc' } },
      },
    });
    const last = await prisma.deployment.findMany({
      where: { sourceId: { in: sources.map((source) => source.id) } },
      orderBy: { createdAt: 'desc' },
      distinct: ['sourceId'],
      select: { sourceId: true, status: true, createdAt: true, commitHash: true, commitMessage: true },
    });
    const lastBySource = new Map(last.map((deployment) => [deployment.sourceId, deployment]));

    const rows = sources.map((source) => ({ ...present(source), lastDeployment: lastBySource.get(source.id) ?? null }));
    const direction = req.query.order === 'desc' ? -1 : 1;
    const SEVERITY: Record<string, number> = { DEPLOYING: 0, ERROR: 1, PARTIAL: 2, STOPPED: 3, RUNNING: 4, EMPTY: 5, DISABLED: 6 };
    const byName = (a: (typeof rows)[number], b: (typeof rows)[number]) => a.name.localeCompare(b.name);
    rows.sort((a, b) => {
      switch (req.query.sort) {
        case 'name':
          return direction * byName(a, b);
        case 'organization':
          return direction * (a.organization?.name ?? '').localeCompare(b.organization?.name ?? '') || byName(a, b);
        case 'server':
          return direction * (a.server?.name ?? '').localeCompare(b.server?.name ?? '') || byName(a, b);
        case 'apps':
          return direction * (a.applications.length - b.applications.length) || byName(a, b);
        default:
          // what needs attention leads
          return (SEVERITY[a.status] ?? 9) - (SEVERITY[b.status] ?? 9) || byName(a, b);
      }
    });

    return res.json({
      success: true,
      data: {
        data: rows.slice(skip, skip + limit),
        pagination: { page, limit, total: rows.length, totalPages: Math.ceil(rows.length / limit) },
      },
    } as ApiResponse);
  } catch (error) {
    console.error('Error listing projects:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

router.get('/:id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const source = await findSource(req, res);
    if (!source) return;
    return res.json({ success: true, data: { ...present(source), canSwitchBranch: await maySwitchBranch(req, source) } } as ApiResponse);
  } catch (error) {
    console.error('Error fetching project:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/**
 * Rename, point at another repository or branch, change its clone account, or
 * (platform admin) give it to another organization — its apps go with it. An
 * imported checkout's repository and branch are what is on the server: the
 * sync reads them, nothing here writes them.
 */
router.patch('/:id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const source = await findSource(req, res);
    if (!source) return;
    const { name, repository, branch, gitAccountId, organizationId } = req.body ?? {};

    const code = repository !== undefined || branch !== undefined || gitAccountId !== undefined;
    if (code && source.path) {
      return res.status(400).json({
        success: false,
        error: 'The repository and branch of a project imported from its server are what is checked out there',
      } as ApiResponse);
    }
    // the clone account may only be one the caller connected themselves —
    // otherwise a source could be pointed at somebody else's token
    if (gitAccountId && !(await prisma.gitAccount.findFirst({ where: { id: String(gitAccountId), userId: req.user!.userId } }))) {
      return res.status(403).json({ success: false, error: 'Unknown git account' } as ApiResponse);
    }

    if (organizationId !== undefined) {
      if (!isPlatformAdmin(req)) {
        return res.status(403).json({ success: false, error: 'Only a platform admin can move a project to another organization' } as ApiResponse);
      }
      if (organizationId && !(await prisma.organization.findUnique({ where: { id: String(organizationId) } }))) {
        return res.status(404).json({ success: false, error: 'Organization not found' } as ApiResponse);
      }
      await setSourceOrganization([source.id], organizationId ? String(organizationId) : null);
    }

    await prisma.source.update({
      where: { id: source.id },
      data: {
        // '' goes back to the derived name
        ...(name !== undefined && { name: String(name ?? '').trim() || null }),
        ...(repository !== undefined && { repository: String(repository ?? '').trim() || null }),
        ...(branch !== undefined && { branch: String(branch ?? '').trim() || 'main' }),
        ...(gitAccountId !== undefined && { gitAccountId: gitAccountId || null }),
      },
    });

    const updated = await findSource(req, res);
    if (!updated) return;
    return res.json({ success: true, data: present(updated), message: 'Project updated' } as ApiResponse);
  } catch (error) {
    console.error('Error updating project:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/**
 * The repository's branches, each one's newest commit, and the commit that is
 * live — "is there something newer" without a clone. An imported checkout is
 * read on its own server with that server's git credentials (usually an SSH
 * deploy key), and what is live is its HEAD.
 */
router.get('/:id/branches', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const source = await findSource(req, res);
    if (!source) return;
    if (!source.repository) {
      return res.status(400).json({ success: false, error: 'This project is not from a repository' } as ApiResponse);
    }
    const branch = source.branch || 'main';

    if (source.path && source.serverId) {
      const server = await prisma.server.findUnique({ where: { id: source.serverId } });
      if (!server) return res.status(409).json({ success: false, error: 'This project is not linked to a server — sync the apps again' } as ApiResponse);
      const git = (args: string[]) => checkoutGit(server, source.path!, args);
      const [remote, head] = await Promise.all([git(['ls-remote', '--symref', 'origin']), git(['rev-parse', 'HEAD']).catch(() => null)]);
      return res.json({
        success: true,
        data: { ...parseLsRemote(remote.stdout), branch, liveCommit: head?.stdout.trim() || null, checkoutCommit: head?.stdout.trim() || null },
      } as ApiResponse);
    }

    const remote = await listRemoteBranches(source.repository, source.gitAccountId ? await gitAuthFor(source.gitAccountId) : undefined);
    // two states: the checkout behind the remote is a pull; the live release behind the checkout is a deploy
    const managed = source.applications.find((app) => !app.runtime);
    const checkout = managed
      ? await sourceFsFor(managed.id)
          .then((afs) => afs.run(['git', 'rev-parse', 'HEAD'], { cwd: afs.sourcesDir }))
          .then(({ stdout }) => stdout.trim() || null)
          .catch(() => null)
      : null;
    return res.json({
      success: true,
      data: { ...remote, branch, liveCommit: source.activeRelease?.commitSha ?? null, checkoutCommit: checkout },
    } as ApiResponse);
  } catch (error: any) {
    return res.status(400).json({
      success: false,
      error: `Could not read the repository: ${error?.stderr || error?.message || String(error)}`.slice(0, 500),
    } as ApiResponse);
  }
});

/**
 * Pull an imported checkout on its server — once, for every app served from
 * it. Code only: no install, no build, no restart (PHP picks it up at once; a
 * pm2 app needs a restart). Fast-forward only, so local edits or a diverged
 * history make it refuse instead of merging. Only as the folder's owner:
 * pulling as another user (root, typically) leaves files the apps cannot write.
 * It lands in the project's history like a deploy.
 */
router.post('/:id/pull', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const source = await findSource(req, res);
    if (!source) return;
    const managed = source.applications.find((app) => !app.runtime);
    if (!source.path && source.repository && managed) {
      // the platform's own checkout: the code only — what runs is the last build until a deploy
      const branch = source.branch || 'main';
      const afs = await sourceFsFor(managed.id);
      try {
        const dir = await deploymentService.syncRepository(afs, source.repository, branch, source.gitAccountId);
        const { stdout } = await afs.run(['git', 'log', '-1', '--format=%h %s'], { cwd: dir });
        return res.json({ success: true, data: { output: `${branch} is at ${stdout.trim()}`, apps: [] }, message: `Pulled ${branch}` } as ApiResponse);
      } catch (error: any) {
        return res.status(502).json({ success: false, error: String(error?.message || error).slice(0, 500) } as ApiResponse);
      }
    }
    // an imported checkout is pulled on its server: the platform's admins only
    if (!isPlatformAdmin(req)) return res.status(403).json({ success: false, error: 'Insufficient permissions' } as ApiResponse);
    if (!source.path || !source.serverId || !source.repository) {
      return res.status(400).json({ success: false, error: 'Only a project checked out on its server from git can be pulled' } as ApiResponse);
    }
    const server = await prisma.server.findUnique({ where: { id: source.serverId } });
    if (!server) return res.status(409).json({ success: false, error: 'This project is not linked to a server — sync the apps again' } as ApiResponse);

    const refused = await notOwner(server, source.path);
    if (refused) return res.status(409).json({ success: false, error: refused } as ApiResponse);

    const branch = source.branch || 'main';
    const first = source.applications[0];
    const record = (status: 'SUCCESS' | 'FAILED', log: string, commit?: { hash?: string | undefined; message?: string | undefined }) =>
      first
        ? prisma.deployment.create({
            data: {
              applicationId: first.id,
              sourceId: source.id,
              userId: req.user!.userId,
              status,
              deployLogs: `git pull --ff-only origin ${branch} in ${source.path}\n\n${log}`,
              commitHash: commit?.hash ?? null,
              commitMessage: commit?.message ?? null,
            },
          })
        : null;

    try {
      const { stdout, stderr } = await checkoutGit(server, source.path, ['pull', '--ff-only', 'origin', branch]);
      const output = `${stdout}${stderr}`.trim();
      const head = await checkoutGit(server, source.path, ['log', '-1', '--format=%H%n%s']).catch(() => null);
      const [hash, message] = (head?.stdout ?? '').trim().split('\n');
      await record('SUCCESS', output, { hash, message });
      return res.json({
        success: true,
        data: { output, apps: source.applications.flatMap((app) => app.domains.map((d) => d.host)) },
        message: `Pulled ${branch}`,
      } as ApiResponse);
    } catch (error: any) {
      const message = String(error?.stderr || error?.message || error).trim().slice(0, 2000);
      await record('FAILED', message);
      return res.status(502).json({ success: false, error: message.slice(0, 500) } as ApiResponse);
    }
  } catch (error) {
    console.error('Error pulling project:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/**
 * Switch an imported checkout to another branch, on its server — for every
 * app served from it. Like a pull: code only (no install, build or restart),
 * and it refuses rather than lose anything — local changes stop it, and the
 * branch only ever moves forward to what the remote has. It lands in the
 * project's history like a deploy.
 */
router.post('/:id/checkout', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const source = await findSource(req, res);
    if (!source) return;
    if (!(await maySwitchBranch(req, source))) {
      return res.status(403).json({ success: false, error: "Only the organization's owner or an admin can switch the branch" } as ApiResponse);
    }
    if (!source.path || !source.serverId || !source.repository) {
      return res.status(400).json({ success: false, error: 'Only a project checked out on its server from git can switch branches here' } as ApiResponse);
    }
    const branch = String(req.body?.branch ?? '').trim();
    if (!isBranchName(branch)) return res.status(400).json({ success: false, error: 'Pick a branch' } as ApiResponse);
    // the sites run the other branch the moment it is checked out: only on an explicit yes
    if (req.body?.consent !== true) {
      return res.status(400).json({ success: false, error: 'Confirm that the sites run the new branch as soon as it is switched' } as ApiResponse);
    }

    const server = await prisma.server.findUnique({ where: { id: source.serverId } });
    if (!server) return res.status(409).json({ success: false, error: 'This project is not linked to a server — sync the apps again' } as ApiResponse);
    const refused = await notOwner(server, source.path);
    if (refused) return res.status(409).json({ success: false, error: refused } as ApiResponse);

    const git = (args: string[]) => checkoutGit(server, source.path!, args);
    // uncommitted edits on the box would be carried along, or block the switch halfway
    const dirty = (await git(['status', '--porcelain', '--untracked-files=no'])).stdout.trim();
    if (dirty) {
      return res.status(409).json({
        success: false,
        error: `${source.path} has local changes — commit or discard them on the server first:\n${dirty.split('\n').slice(0, 5).join('\n')}`,
      } as ApiResponse);
    }

    const first = source.applications[0];
    const log: string[] = [];
    const step = async (args: string[]) => {
      log.push(`$ git ${args.join(' ')}`);
      const { stdout, stderr } = await git(args);
      if (`${stdout}${stderr}`.trim()) log.push(`${stdout}${stderr}`.trim());
    };
    const record = (status: 'SUCCESS' | 'FAILED', commit?: { hash?: string | undefined; message?: string | undefined }) =>
      first
        ? prisma.deployment.create({
            data: {
              applicationId: first.id,
              sourceId: source.id,
              userId: req.user!.userId,
              status,
              deployLogs: `Switch ${source.path} to ${branch}\n\n${log.join('\n')}`,
              commitHash: commit?.hash ?? null,
              commitMessage: commit?.message ?? null,
            },
          })
        : null;

    try {
      // a single-branch clone has no ref for the others: fetch this one by name
      await step(['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      const local = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
      // an existing local branch keeps its commits: switched to, then moved forward only
      await step(local ? ['checkout', branch] : ['checkout', '-b', branch, '--track', `origin/${branch}`]);
      if (local) await step(['merge', '--ff-only', `origin/${branch}`]);
      const head = await git(['log', '-1', '--format=%H%n%s']).catch(() => null);
      const [hash, message] = (head?.stdout ?? '').trim().split('\n');
      await prisma.source.update({ where: { id: source.id }, data: { branch } });
      await record('SUCCESS', { hash, message });
      return res.json({
        success: true,
        data: { output: log.join('\n'), apps: source.applications.flatMap((app) => app.domains.map((d) => d.host)) },
        message: `Switched to ${branch}`,
      } as ApiResponse);
    } catch (error: any) {
      log.push(String(error?.stderr || error?.message || error).trim());
      await record('FAILED');
      return res.status(502).json({ success: false, error: log[log.length - 1]!.slice(0, 500) } as ApiResponse);
    }
  } catch (error) {
    console.error('Error switching branch:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/**
 * Build every imported app of the project where it lives — sites' files
 * first, then the processes, one after the other (pm2DeployService). The sites
 * can err while they build, so only on an explicit yes, and only by the
 * organization's owner or admin. Answers with the apps it builds; each writes
 * its own deployment row.
 */
router.post('/:id/build', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const source = await findSource(req, res);
    if (!source) return;
    if (!(await maySwitchBranch(req, source))) {
      return res.status(403).json({ success: false, error: "Only the organization's owner or an admin can build it" } as ApiResponse);
    }
    if (req.body?.consent !== true) {
      return res.status(400).json({ success: false, error: 'Confirm that the sites may err while they build' } as ApiResponse);
    }
    const apps = await buildProject(source.id, req.user!.userId);
    if (apps.length === 0) return res.status(400).json({ success: false, error: 'Nothing in this project is built on its server' } as ApiResponse);
    return res.status(202).json({ success: true, data: { apps }, message: `Building ${apps.length} app(s)` } as ApiResponse);
  } catch (error) {
    console.error('Error building the project:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/** Deploy every app of a panel-managed project: each launched on its own, all at once. */
router.post('/:id/deploy', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const source = await findSource(req, res);
    if (!source) return;
    const managed = source.applications.filter((app) => !app.runtime);
    if (source.path || managed.length === 0) {
      return res.status(409).json({
        success: false,
        error: 'This project was imported from its server and is managed there — pull it instead',
      } as ApiResponse);
    }

    const applications = await prisma.application.findMany({ where: { id: { in: managed.map((app) => app.id) } } });
    const launched: string[] = [];
    const busy: string[] = [];
    for (const application of applications) {
      const started = await launchDeploy(application, req.user!.userId);
      if (started) launched.push(started.deploymentId);
      else busy.push(application.name);
    }
    if (launched.length === 0) return res.status(409).json({ success: false, error: 'A deployment is already in progress' } as ApiResponse);
    return res.json({
      success: true,
      data: { deploymentIds: launched, deploymentId: launched[0] },
      message: busy.length ? `Deployment started; ${busy.join(', ')} already deploying` : 'Deployment started',
    } as ApiResponse);
  } catch (error) {
    console.error('Error deploying project:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

export default router;
