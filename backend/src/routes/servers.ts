import { Router, Response } from 'express';
import path from 'path';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiResponse } from '../types';
import { validateRequest } from '../middleware/validation';
import { authenticateToken, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { paging, contains } from '../lib/paging';
import { pingServer } from '../services/serverHealthService';
import { queueServerSetup } from '../services/serverSetupService';
import { exec, RemoteExecError } from '../lib/runner';
import { snapshotNode } from '../services/caddySnapshotService';
import { syncServerApps, classifyRoute, routeHosts, isNotAnApp } from '../services/appSyncService';
import { getCaddyConfig, allRoutesOf } from '../services/caddyService';
import { canEncrypt, encrypt } from '../lib/secretBox';
import { appsOnServer } from '../lib/servers';

const router = Router();

/**
 * Provisioning nodes.
 *
 * Registering a node means telling the control plane how to reach it over SSH.
 * Every field here ends up as an argument to a root command on that box, so
 * this route is a trust boundary even though only a superadmin can reach it.
 */

/**
 * Directory the SSH private keys live in on the CONTROL PLANE.
 *
 * sshKeyPath is a control-plane filesystem path arriving from a form, and the
 * runner reads whatever it points at. Without a fence a superadmin could aim a
 * "server" at /etc/shadow and read it back through a connection error. Keys
 * belong in one directory anyway, so confining the path there costs nothing.
 */
const SSH_KEY_DIR = path.resolve(
  process.env.CB_SSH_KEY_DIR || path.dirname(process.env.CB_SSH_KEY_PATH || '/opt/larika/.ssh/id_ed25519')
);

/** Reject anything outside SSH_KEY_DIR, including via `..`. */
export function keyPathError(sshKeyPath: string): string | null {
  const resolved = path.resolve(sshKeyPath);
  if (resolved !== SSH_KEY_DIR && !resolved.startsWith(SSH_KEY_DIR + path.sep)) {
    return `sshKeyPath must be inside ${SSH_KEY_DIR}`;
  }
  return null;
}

const ServerSchema = z.object({
  name: z.string().min(2).max(60),
  hostname: z.string().min(1).max(255),
  sshUser: z.string().min(1).max(32).regex(/^[a-z_][a-z0-9_-]*$/, 'invalid unix username'),
  sshPort: z.coerce.number().int().min(1).max(65535).default(22),
  authMethod: z.enum(['KEY', 'PASSWORD']).default('KEY'),
  sshKeyPath: z.string().min(1).optional(),
  sshPassword: z.string().min(1).max(512).optional(),
  publicIp: z.string().min(1).max(255),
  caddyApiUrl: z.string().max(255).default(''),
  // free-form labels, normalised so "Production" and "production " are one tag
  tags: z
    .array(z.string().trim().min(1).max(30))
    .max(20)
    .default([])
    .transform((tags) => [...new Set(tags.map((tag) => tag.toLowerCase()))]),
});

const UpdateServerSchema = ServerSchema.partial();

// organizations provisioned on the node — an org can be on several
const withCounts = { _count: { select: { orgNodes: true } } } as const;

/**
 * The stored password is ciphertext, but it is still the credential for a shell
 * on that box — it never goes out over the API, not even encrypted.
 */
function redact<T extends { sshPassword?: string | null }>(server: T) {
  const { sshPassword, ...rest } = server;
  return { ...rest, hasPassword: !!sshPassword };
}

/**
 * A node needs exactly one working credential. Checked here rather than at
 * connect time so a server cannot be saved in a state that only fails later,
 * halfway through a deploy.
 */
function credentialError(
  data: {
    authMethod?: string | undefined;
    sshKeyPath?: string | undefined;
    sshPassword?: string | undefined;
  },
  existing?: { authMethod: string; sshKeyPath: string | null; sshPassword: string | null },
): string | null {
  const method = data.authMethod ?? existing?.authMethod ?? 'KEY';

  if (method === 'PASSWORD') {
    if (!data.sshPassword && !existing?.sshPassword) {
      return 'A password is required when authMethod is PASSWORD';
    }
    if (data.sshPassword && !canEncrypt()) {
      return 'CB_SECRET_KEY is not set, so an SSH password cannot be stored — set it or use key authentication';
    }
    return null;
  }

  if (!data.sshKeyPath && !existing?.sshKeyPath) {
    return 'A key path is required when authMethod is KEY';
  }
  return null;
}

// List nodes. Unpaged for the org-placement picker, paged for the table.
router.get('/', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, limit, skip, search, paged } = paging(req);
    // ?tag=production narrows the list to one label; search still matches names
    const tag = String(req.query.tag ?? '').trim().toLowerCase();
    const where = {
      ...(search && {
        OR: [{ name: contains(search) }, { hostname: contains(search) }, { publicIp: contains(search) }],
      }),
      ...(tag && { tags: { has: tag } }),
    };

    const [servers, total] = await Promise.all([
      prisma.server.findMany({
        where,
        include: withCounts,
        orderBy: { createdAt: 'asc' },
        ...(paged && { skip, take: limit }),
      }),
      paged ? prisma.server.count({ where }) : Promise.resolve(0),
    ]);

    return res.json({
      success: true,
      data: paged
        ? { data: servers.map(redact), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } }
        : servers.map(redact),
    } as ApiResponse);
  } catch (error) {
    console.error('Error listing servers:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

router.get('/:id', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const server = await prisma.server.findUnique({
      where: { id: req.params.id as string },
      include: {
        ...withCounts,
        orgNodes: {
          select: { state: true, organization: { select: { id: true, name: true, slug: true } } },
          orderBy: { organization: { name: 'asc' } },
        },
      },
    });
    if (!server) return res.status(404).json({ success: false, error: 'Server not found' } as ApiResponse);
    const { orgNodes, ...rest } = server;
    return res.json({
      success: true,
      data: redact({ ...rest, organizations: orgNodes.map(({ organization, state }) => ({ ...organization, state })) }),
    } as ApiResponse);
  } catch (error) {
    console.error('Error fetching server:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

// Register a node, then ping it so the row is never born with an unknown status.
router.post(
  '/',
  authenticateToken,
  requireRole(['SUPERADMIN']),
  validateRequest(ServerSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const data = ServerSchema.parse(req.body);

      const credError = credentialError(data);
      if (credError) return res.status(400).json({ success: false, error: credError } as ApiResponse);

      if (data.sshKeyPath) {
        const keyError = keyPathError(data.sshKeyPath);
        if (keyError) return res.status(400).json({ success: false, error: keyError } as ApiResponse);
      }

      // the password is encrypted on the way in and never stored as typed, and
      // an omitted optional must be absent rather than an explicit undefined
      const fields = Object.fromEntries(
        Object.entries({ ...data, ...(data.sshPassword && { sshPassword: encrypt(data.sshPassword) }) })
          .filter(([, value]) => value !== undefined),
      ) as any;

      const server = await prisma.server.create({ data: fields, include: withCounts });
      const ping = await pingServer(server).catch(() => null);

      // Take a copy of whatever Caddy is already serving on this box before
      // anything touches it. Routes live in Caddy's memory with no files behind
      // them, so a node registered without a snapshot has a window where a
      // reload would lose every site it was already hosting.
      //
      // Only once the node actually answers, though: snapshotting a box we
      // cannot reach stores nothing and reports a failure the operator can do
      // nothing about yet. An unreachable node is snapshotted by the next
      // successful health check instead.
      const reachable = ping?.status === 'ONLINE';
      const snapshot = reachable
        ? await snapshotNode(server).catch(
            (error: any) => `${server.hostname}: ${error?.message ?? 'snapshot failed'}`,
          )
        : 'not reachable yet — Caddy will be snapshotted once it answers';
      console.log(`💾 Caddy config: ${snapshot}`);

      // Then the inventory: whatever this box was already serving becomes
      // application rows, unassigned until a superadmin gives them an owner.
      const inventory = reachable
        ? await syncServerApps(req.user!.userId, server).catch((error: any) => ({
            discovered: 0,
            created: 0,
            updated: 0,
            apps: [],
            errors: [String(error?.message ?? 'scan failed')],
          }))
        : { discovered: 0, created: 0, updated: 0, apps: [], errors: [] };

      const fresh = await prisma.server.findUnique({ where: { id: server.id }, include: withCounts });
      return res.status(201).json({
        success: true,
        data: fresh ? redact(fresh) : null,
        message: reachable
          ? `Server registered — ${snapshot}, ${inventory.created} app(s) imported, ${inventory.updated} updated`
          : `Server registered, but it is not reachable yet: ${ping?.error ?? 'no answer'}`,
      } as ApiResponse);
    } catch (error) {
      console.error('Error creating server:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
    }
  }
);

router.put(
  '/:id',
  authenticateToken,
  requireRole(['SUPERADMIN']),
  validateRequest(UpdateServerSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const data = UpdateServerSchema.parse(req.body);

      if (data.sshKeyPath) {
        const keyError = keyPathError(data.sshKeyPath);
        if (keyError) return res.status(400).json({ success: false, error: keyError } as ApiResponse);
      }

      const current = await prisma.server.findUnique({
        where: { id: req.params.id as string },
        select: { authMethod: true, sshKeyPath: true, sshPassword: true },
      });
      if (!current) return res.status(404).json({ success: false, error: 'Server not found' } as ApiResponse);

      const credError = credentialError(data, current);
      if (credError) return res.status(400).json({ success: false, error: credError } as ApiResponse);

      // Drop the keys the caller omitted: under exactOptionalPropertyTypes an
      // explicit `undefined` is not the same as "leave this column alone".
      const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
      if (typeof patch.sshPassword === 'string') patch.sshPassword = encrypt(patch.sshPassword);

      const server = await prisma.server.update({
        where: { id: req.params.id as string },
        data: patch,
        include: withCounts,
      });

      // A new hostname or key can mean a different box, or the first time this
      // one was reachable at all — either way its Caddy is worth re-reading.
      const snapshot =
        patch.hostname || patch.sshKeyPath || patch.sshUser || patch.sshPort
          ? await snapshotNode(server).catch((error: any) => `snapshot failed: ${error?.message}`)
          : null;

      return res.json({
        success: true,
        data: redact(server),
        message: snapshot ? `Server updated — ${snapshot}` : 'Server updated',
      } as ApiResponse);
    } catch (error: any) {
      if (error?.code === 'P2025') {
        return res.status(404).json({ success: false, error: 'Server not found' } as ApiResponse);
      }
      console.error('Error updating server:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
    }
  }
);

/** What this node's Caddy is serving right now, typed as applications. */
router.get('/:id/caddy/routes', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const server = await prisma.server.findUnique({ where: { id: req.params.id as string } });
    if (!server) return res.status(404).json({ success: false, error: 'Server not found' } as ApiResponse);

    const config = await getCaddyConfig(server);
    if (config === null) {
      return res.status(502).json({ success: false, error: 'Caddy on this node did not answer' } as ApiResponse);
    }

    // whatever server block the node keeps its sites in, not just ours
    const routes = allRoutesOf(config);
    const sites = routes.flatMap((route) => {
      const target = classifyRoute(route);
      return routeHosts(route).map((host) => ({
        host,
        // a route we cannot type is still worth showing — it is serving traffic
        kind: target?.type ?? 'OTHER',
        port: target?.port ?? null,
        rootPath: target?.rootPath ?? null,
        socket: target?.socket ?? null,
        origin: target?.origin ?? null,
        managed: !isNotAnApp(host),
      }));
    });

    return res.json({ success: true, data: sites } as ApiResponse);
  } catch (error: any) {
    console.error('Error reading Caddy routes:', error);
    return res.status(502).json({
      success: false,
      error: error?.message || 'Could not read the routes from this node',
    } as ApiResponse);
  }
});

/**
 * Turn this node's live Caddy routes into application rows.
 *
 * The routes are the truth about what the box serves; the rows are how the
 * panel can manage it. Additive and re-runnable — an existing row is refreshed,
 * never replaced, and nothing is deleted when a route disappears.
 */
router.post('/:id/sync-apps', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const server = await prisma.server.findUnique({ where: { id: req.params.id as string } });
    if (!server) return res.status(404).json({ success: false, error: 'Server not found' } as ApiResponse);

    const result = await syncServerApps(req.user!.userId, server);

    return res.json({
      success: true,
      data: result,
      message: `${result.discovered} site(s) found — ${result.created} imported, ${result.updated} updated`,
    } as ApiResponse);
  } catch (error: any) {
    console.error('Error syncing apps from server:', error);
    return res.status(502).json({
      success: false,
      error: error?.message || 'Could not read this node',
    } as ApiResponse);
  }
});

/** Applications placed on this node, through their organization. */
router.get('/:id/apps', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const apps = await prisma.application.findMany({
      // discovered on this node, or owned by an organization placed on it —
      // an imported app has no organization until a superadmin assigns one
      where: appsOnServer(id),
      select: {
        id: true,
        name: true,
        domain: true,
        type: true,
        status: true,
        port: true,
        runtime: true,
        lastDeployment: true,
        organization: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { domain: 'asc' },
    });

    return res.json({ success: true, data: apps } as ApiResponse);
  } catch (error) {
    console.error('Error listing server apps:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/** Config backups taken from this node, newest first. */
router.get('/:id/caddy/snapshots', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const snapshots = await prisma.caddySnapshot.findMany({
      where: { serverId: req.params.id as string },
      orderBy: { createdAt: 'desc' },
      // the config itself can be megabytes — the list only needs its shape
      select: { id: true, hosts: true, createdAt: true },
    });

    return res.json({ success: true, data: snapshots } as ApiResponse);
  } catch (error) {
    console.error('Error listing Caddy snapshots:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/** Re-read this node's Caddy config into a snapshot, now. */
router.post('/:id/caddy/snapshot', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const server = await prisma.server.findUnique({ where: { id: req.params.id as string } });
    if (!server) return res.status(404).json({ success: false, error: 'Server not found' } as ApiResponse);

    return res.json({ success: true, message: await snapshotNode(server) } as ApiResponse);
  } catch (error: any) {
    console.error('Error snapshotting Caddy config:', error);
    return res.status(502).json({
      success: false,
      error: error?.message || 'Could not read the Caddy config from this server',
    } as ApiResponse);
  }
});

/**
 * Delete a node. Refused while apps or organization homes are still on it.
 */
router.delete('/:id', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    // Apps and org homes live on the box; a row with no server is an app whose
    // next deploy fails with no way to find where its files went.
    const [apps, orgs] = await Promise.all([
      prisma.application.count({ where: { serverId: id } }),
      prisma.orgNode.count({ where: { serverId: id } }),
    ]);
    if (apps > 0 || orgs > 0) {
      return res.status(400).json({
        success: false,
        error: `${apps} app(s) and ${orgs} organization(s) are still on this server — move or delete them before deleting it`,
      } as ApiResponse);
    }
    // it may still be some organization's default for new apps; that just clears
    await prisma.organization.updateMany({ where: { defaultServerId: id }, data: { defaultServerId: null } });

    await prisma.server.delete({ where: { id } });
    return res.json({ success: true, message: 'Server deleted' } as ApiResponse);
  } catch (error: any) {
    if (error?.code === 'P2025') {
      return res.status(404).json({ success: false, error: 'Server not found' } as ApiResponse);
    }
    console.error('Error deleting server:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

// Queue install.sh on this box, run over SSH. Idempotent: re-running
// upgrades packages and re-applies the config install.sh owns.
router.post('/:id/setup', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const server = await prisma.server.findUnique({ where: { id: req.params.id as string }, select: { id: true, name: true } });
    if (!server) return res.status(404).json({ success: false, error: 'Server not found' } as ApiResponse);

    await queueServerSetup(server.id);
    return res.status(202).json({
      success: true,
      data: { setupState: 'QUEUED' },
      message: `Setup queued for ${server.name}`,
    } as ApiResponse);
  } catch (error) {
    console.error('Error queueing server setup:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

// Check one node now instead of waiting for the cron heartbeat.
router.post('/:id/ping', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const server = await prisma.server.findUnique({ where: { id: req.params.id as string } });
    if (!server) return res.status(404).json({ success: false, error: 'Server not found' } as ApiResponse);

    const result = await pingServer(server);
    return res.json({ success: true, data: result, message: `Server is ${result.status}` } as ApiResponse);
  } catch (error) {
    console.error('Error pinging server:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/**
 * Node logs.
 *
 * A fixed set of commands, never a command from the request. A superadmin can
 * already SSH to the box, so this is not a privilege boundary — it is a
 * blast-radius one: an endpoint that runs arbitrary remote strings is a remote
 * shell that outlives whoever added it, and this one cannot become that.
 */
const LOG_SOURCES: Record<string, string[]> = {
  system: [],
  caddy: ['-u', 'caddy'],
  // Debian calls the unit ssh, RHEL calls it sshd — ask for both, journalctl
  // ignores a unit that does not exist.
  ssh: ['-u', 'ssh', '-u', 'sshd'],
  php: ['-u', 'php*-fpm.service'],
  // Every app unit cb-app-unit.sh installs is cb-<slug>-<appId>.service
  apps: ['-u', 'cb-*.service'],
  // Priority error and worse, across every unit — the first place to look when
  // a node misbehaves and you do not yet know which service is at fault.
  errors: ['-p', 'err'],
};

const LogQuerySchema = z.object({
  source: z.enum(['system', 'caddy', 'ssh', 'php', 'apps', 'errors']).default('system'),
  lines: z.coerce.number().int().min(1).max(2000).default(200),
});

router.get('/:id/logs', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const parsed = LogQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Unknown log source' } as ApiResponse);
    }
    const { source, lines } = parsed.data;

    const server = await prisma.server.findUnique({ where: { id: req.params.id as string } });
    if (!server) return res.status(404).json({ success: false, error: 'Server not found' } as ApiResponse);

    const argv = [
      'journalctl',
      '--no-pager',
      '-o',
      'short-iso',
      '-n',
      String(lines),
      ...(LOG_SOURCES[source] as string[]),
    ];

    try {
      const { stdout, stderr } = await exec(server, argv, { timeout: 20_000 });
      return res.json({
        success: true,
        data: { source, lines, output: stdout || stderr || '(no output)' },
      } as ApiResponse);
    } catch (err: any) {
      // journalctl exits non-zero when the SSH user may not read the journal.
      // That is a node configuration answer, not a panel error, so it comes
      // back as data with the fix in it rather than as a 500.
      const detail = err instanceof RemoteExecError ? err.stderr || err.stdout || err.message : String(err?.message || err);
      const hint = /permission|not seen|no journal|Operation not permitted/i.test(detail)
        ? `

${server.sshUser} may not read the system journal on this node. Fix with: usermod -aG systemd-journal ${server.sshUser}`
        : '';
      return res.json({ success: true, data: { source, lines, output: detail + hint } } as ApiResponse);
    }
  } catch (error) {
    console.error('Error reading server logs:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

export default router;
