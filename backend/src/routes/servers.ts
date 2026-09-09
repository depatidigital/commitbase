import { Router, Response } from 'express';
import path from 'path';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiResponse } from '../types';
import { validateRequest } from '../middleware/validation';
import { authenticateToken, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { paging, contains } from '../lib/paging';
import { pingServer } from '../services/serverHealthService';

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
  process.env.CB_SSH_KEY_DIR || path.dirname(process.env.CB_SSH_KEY_PATH || '/home/commitbase/.ssh/id_ed25519')
);

/** Reject anything outside SSH_KEY_DIR, including via `..`. */
function keyPathError(sshKeyPath: string): string | null {
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
  sshKeyPath: z.string().min(1),
  publicIp: z.string().min(1).max(255),
  caddyApiUrl: z.string().max(255).default(''),
});

const UpdateServerSchema = ServerSchema.partial();

const withCounts = { _count: { select: { organizations: true } } } as const;

// List nodes. Unpaged for the org-placement picker, paged for the table.
router.get('/', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, limit, skip, search, paged } = paging(req);
    const where = search
      ? { OR: [{ name: contains(search) }, { hostname: contains(search) }, { publicIp: contains(search) }] }
      : {};

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
        ? { data: servers, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } }
        : servers,
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
        organizations: { select: { id: true, name: true, slug: true }, orderBy: { name: 'asc' } },
      },
    });
    if (!server) return res.status(404).json({ success: false, error: 'Server not found' } as ApiResponse);
    return res.json({ success: true, data: server } as ApiResponse);
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

      const keyError = keyPathError(data.sshKeyPath);
      if (keyError) return res.status(400).json({ success: false, error: keyError } as ApiResponse);

      const server = await prisma.server.create({ data, include: withCounts });
      await pingServer(server).catch(() => {});

      const fresh = await prisma.server.findUnique({ where: { id: server.id }, include: withCounts });
      return res.status(201).json({ success: true, data: fresh, message: 'Server registered' } as ApiResponse);
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

      // Drop the keys the caller omitted: under exactOptionalPropertyTypes an
      // explicit `undefined` is not the same as "leave this column alone".
      const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));

      const server = await prisma.server.update({
        where: { id: req.params.id as string },
        data: patch,
        include: withCounts,
      });
      return res.json({ success: true, data: server, message: 'Server updated' } as ApiResponse);
    } catch (error: any) {
      if (error?.code === 'P2025') {
        return res.status(404).json({ success: false, error: 'Server not found' } as ApiResponse);
      }
      console.error('Error updating server:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
    }
  }
);

/**
 * Delete a node. Refused while organizations still sit on it: their homes and
 * apps live on that box, and a row with no server is an org whose next deploy
 * fails with no way to find where its files went.
 */
router.delete('/:id', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const placed = await prisma.organization.count({ where: { serverId: id } });
    if (placed > 0) {
      return res.status(400).json({
        success: false,
        error: `${placed} organization(s) still placed on this server — move them before deleting it`,
      } as ApiResponse);
    }

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

export default router;
