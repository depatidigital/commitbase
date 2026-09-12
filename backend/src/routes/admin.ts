import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiResponse } from '../types';
import { validateRequest } from '../middleware/validation';
import { AuthenticatedRequest } from '../middleware/auth';
import { paging, paginated, contains } from '../lib/paging';
import {
  queueOrgNode,
  queueOrgEverywhere,
  orgNodesInclude,
} from '../services/orgProvisionService';

// Mounted at /api/admin behind authenticateToken + requireRole(['ADMIN']) in index.ts.
const router = Router();

const CreateClientSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).optional(),
  password: z.string().min(8),
  role: z.enum(['ADMIN', 'USER', 'CLIENT']).optional(),
});

const UpdateUserSchema = z.object({
  isActive: z.boolean().optional(),
  role: z.enum(['ADMIN', 'USER', 'CLIENT']).optional(),
  name: z.string().min(1).optional(),
});

const AssignDomainSchema = z.object({
  organizationId: z.string().min(1),
});

const userSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  createdAt: true,
  memberships: {
    select: {
      role: true,
      organization: { select: { id: true, name: true, slug: true } },
    },
  },
} as const;

// List users
router.get('/users', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, limit, skip, search } = paging(req);
    const where = search ? { OR: [{ email: contains(search) }, { name: contains(search) }] } : {};

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: userSelect,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);

    return res.json(paginated(users, total, page, limit) as ApiResponse);
  } catch (error) {
    console.error('Error listing users:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

// Create a client account (replaces public registration)
router.post('/users', validateRequest(CreateClientSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { email, name, password, role } = req.body;
    const normalizedEmail = String(email).trim().toLowerCase();

    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      return res.status(400).json({ success: false, error: 'User with this email already exists' } as ApiResponse);
    }

    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        name,
        password: await bcrypt.hash(password, 12),
        role: role ?? 'CLIENT',
        mustChangePassword: true, // the admin knows this password; force a rotation
      },
      select: userSelect,
    });

    return res.status(201).json({ success: true, data: user, message: 'User created' } as ApiResponse);
  } catch (error) {
    console.error('Error creating user:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

// Enable/disable or re-role a user
router.put('/users/:id', validateRequest(UpdateUserSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    if (id === req.user!.userId && req.body.isActive === false) {
      return res.status(400).json({ success: false, error: 'You cannot disable your own account' } as ApiResponse);
    }

    // explicit fields only — never hand req.body straight to Prisma
    const { isActive, role, name } = req.body;
    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(isActive !== undefined && { isActive }),
        ...(role !== undefined && { role }),
        ...(name !== undefined && { name }),
      },
      select: userSelect,
    });

    return res.json({ success: true, data: user, message: 'User updated' } as ApiResponse);
  } catch (error) {
    console.error('Error updating user:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

// List every domain with its owner (admin view — the tenant-scoped list lives at /api/domains)
router.get('/domains', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, limit, skip, search } = paging(req);
    const where = search ? { name: contains(search) } : {};

    const [domains, total] = await Promise.all([
      prisma.domain.findMany({
        where,
        include: {
          organization: { select: { id: true, name: true, slug: true } },
          user: { select: { id: true, email: true, name: true, role: true } },
          _count: { select: { applications: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.domain.count({ where }),
    ]);

    return res.json(paginated(domains, total, page, limit) as ApiResponse);
  } catch (error) {
    console.error('Error listing domains:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/**
 * Assign (or transfer) a domain to an organization.
 * Applications under the domain move with it — otherwise the previous org keeps
 * reading an app on a hostname it no longer controls.
 */
router.post('/domains/:id/assign', validateRequest(AssignDomainSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const { organizationId } = req.body;

    const [domain, target] = await Promise.all([
      prisma.domain.findUnique({ where: { id } }),
      prisma.organization.findUnique({ where: { id: organizationId } }),
    ]);

    if (!domain) {
      return res.status(404).json({ success: false, error: 'Domain not found' } as ApiResponse);
    }
    if (!target) {
      return res.status(404).json({ success: false, error: 'Target organization not found' } as ApiResponse);
    }

    const [updated] = await prisma.$transaction([
      prisma.domain.update({ where: { id }, data: { organizationId } }),
      prisma.application.updateMany({ where: { domainId: id }, data: { organizationId } }),
    ]);

    return res.json({ success: true, data: updated, message: `Domain assigned to ${target.name}` } as ApiResponse);
  } catch (error) {
    console.error('Error assigning domain:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

// Unassign: detach the domain (and its apps) from any organization
router.delete('/domains/:id/assign', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const domain = await prisma.domain.findUnique({ where: { id } });
    if (!domain) {
      return res.status(404).json({ success: false, error: 'Domain not found' } as ApiResponse);
    }

    const [updated] = await prisma.$transaction([
      prisma.domain.update({ where: { id }, data: { organizationId: null } }),
      prisma.application.updateMany({ where: { domainId: id }, data: { organizationId: null } }),
    ]);

    return res.json({ success: true, data: updated, message: 'Domain unassigned' } as ApiResponse);
  } catch (error) {
    console.error('Error unassigning domain:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});



// --- Organization provisioning ----------------------------------------------
// Provisioning normally runs on its own: when an org's first app lands on a
// node, or its default server is set. These endpoints exist for the cases where
// that is not enough: isolation was switched on after the fact, a box was
// rebuilt, limits changed, or a run failed.

// Organizations with their OS-isolation state
router.get('/organizations', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, limit, skip, search } = paging(req);
    const where = search ? { OR: [{ name: contains(search) }, { slug: contains(search) }] } : {};

    const [organizations, total] = await Promise.all([
      prisma.organization.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: { select: { members: true, domains: true, applications: true } },
          // per node: an org is provisioned on each node it uses
          defaultServer: { select: { id: true, name: true, status: true } }, nodes: orgNodesInclude, postgresServer: { select: { id: true, name: true, status: true } }, mysqlServer: { select: { id: true, name: true, status: true } },
        },
      }),
      prisma.organization.count({ where }),
    ]);

    // State comes from the org_nodes rows the provisioning worker keeps — no
    // SSH per org per node on every page load.
    return res.json(paginated(organizations, total, page, limit));
  } catch (error) {
    console.error('Error listing organizations:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

// Provisioning state for one organization, per node
router.get('/organizations/:id/provision', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: req.params.id as string },
      select: { slug: true, uid: true, nodes: orgNodesInclude },
    });
    if (!org) {
      return res.status(404).json({ success: false, error: 'Organization not found' } as ApiResponse);
    }
    return res.json({ success: true, data: { osUser: `cb-${org.slug}`, ...org } } as ApiResponse);
  } catch (error) {
    console.error('Error reading provisioning status:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

const ProvisionSchema = z.object({
  // one node; omitted = every node the org is on (its default server when it is on none yet)
  serverId: z.string().min(1).optional(),
  diskQuota: z.string().optional(),
  cpuQuota: z.string().optional(),
  memoryMax: z.string().optional(),
});

// Run (or re-run) provisioning. The script is idempotent, so this doubles as
// "repair ownership" and "apply new resource limits".
router.post('/organizations/:id/provision', validateRequest(ProvisionSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const org = await prisma.organization.findUnique({ where: { id: req.params.id as string } });
    if (!org) {
      return res.status(404).json({ success: false, error: 'Organization not found' } as ApiResponse);
    }

    // Queued, not run: the list polls each node's state for the outcome.
    const { serverId, diskQuota, cpuQuota, memoryMax } = ProvisionSchema.parse(req.body ?? {});
    const job = {
      userId: req.user!.userId,
      trigger: 'admin',
      ...(diskQuota && { diskQuota }),
      ...(cpuQuota && { cpuQuota }),
      ...(memoryMax && { memoryMax }),
    };

    let queued = 0;
    if (serverId) {
      if (!(await prisma.server.findUnique({ where: { id: serverId }, select: { id: true } }))) {
        return res.status(400).json({ success: false, error: 'Unknown server' } as ApiResponse);
      }
      await queueOrgNode(org.id, serverId, job);
      queued = 1;
    } else {
      queued = await queueOrgEverywhere(org.id, job);
      if (queued === 0 && org.defaultServerId) {
        await queueOrgNode(org.id, org.defaultServerId, job);
        queued = 1;
      }
    }

    if (queued === 0) {
      return res.status(400).json({
        success: false,
        error: 'This organization is on no server yet — set its default server, or pick one',
      } as ApiResponse);
    }

    return res.status(202).json({
      success: true,
      data: { queued },
      message: `Queued cb-${org.slug} on ${queued} server(s)`,
    } as ApiResponse);
  } catch (error: any) {
    const message = error?.stderr || error?.message || String(error);
    console.error('Provisioning failed:', message);
    return res.status(500).json({ success: false, error: message } as ApiResponse);
  }
});

// Provisioning log, newest first. Optional ?organizationId= to scope it.
router.get('/provision-logs', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, limit, skip } = paging(req);
    const organizationId = req.query.organizationId as string | undefined;

    const where = {
      AND: [
        { metadata: { path: ['scope'], equals: 'provisioning' } },
        ...(organizationId ? [{ metadata: { path: ['organizationId'], equals: organizationId } }] : []),
      ],
    } as any;

    const [logs, total] = await Promise.all([
      prisma.log.findMany({
        where,
        skip,
        take: limit,
        orderBy: { timestamp: 'desc' },
        include: { user: { select: { id: true, email: true, name: true } } },
      }),
      prisma.log.count({ where }),
    ]);

    return res.json(paginated(logs, total, page, limit));
  } catch (error) {
    console.error('Error reading provisioning logs:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

export default router;
