import { Router, Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiResponse } from '../types';
import { validateRequest } from '../middleware/validation';
import { authenticateToken, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { canManageOrg, getMemberships, getOrgIds, isPlatformAdmin } from '../lib/scope';
import { paging, contains } from '../lib/paging';
import { sendMail } from '../lib/mailer';
import { queueOrgProvision, OS_ISOLATION_ENABLED } from '../services/orgProvisionService';

const router = Router();

const CreateOrgSchema = z.object({
  name: z.string().min(2),
  slug: z
    .string()
    .min(2)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, numbers and dashes')
    .optional(),
});

const InviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']).optional(),
});

const MemberRoleSchema = z.object({
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']),
});

const AddMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']).optional(),
});

const PlacementSchema = z.object({
  // null unplaces the org — provisioning then refuses until it is placed again
  serverId: z.string().min(1).nullable(),
});

const DatabasePlacementSchema = z.object({
  engine: z.enum(['POSTGRESQL', 'MYSQL']),
  // null unplaces — creating a database of that engine is then refused
  databaseServerId: z.string().min(1).nullable(),
});

const INVITE_TTL_DAYS = 7;

const slugify = (name: string) =>
  name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Issue a fresh invite for an email on an org. Returns the raw token once —
 * it is stored hashed and cannot be read back.
 */
async function issueInvite(orgId: string, email: string, role: 'OWNER' | 'ADMIN' | 'MEMBER', invitedById: string) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  // one live invite per email per org — reissuing replaces the old token
  await prisma.invite.deleteMany({ where: { organizationId: orgId, email, acceptedAt: null } });

  const invite = await prisma.invite.create({
    data: { email, role, tokenHash: hashToken(token), expiresAt, organizationId: orgId, invitedById },
    select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
  });

  const acceptUrl = process.env.APP_URL
    ? `${process.env.APP_URL.replace(/\/$/, '')}/accept-invite?token=${token}`
    : null;

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { name: true },
  });
  const appName = process.env.APP_NAME || 'Larika';

  // best effort: the link is still returned to the caller if the mail fails
  const emailed = acceptUrl
    ? await sendMail({
        to: email,
        subject: `You have been invited to ${org?.name || appName}`,
        text: [
          `You have been invited to join ${org?.name || appName} on ${appName} as ${role}.`,
          '',
          `Accept the invite: ${acceptUrl}`,
          '',
          `The link expires on ${expiresAt.toDateString()}.`,
        ].join('\n'),
        html: `<p>You have been invited to join <strong>${org?.name || appName}</strong> on ${appName} as <strong>${role}</strong>.</p>
<p><a href="${acceptUrl}">Accept the invite</a></p>
<p>The link expires on ${expiresAt.toDateString()}.</p>`,
      })
    : false;

  if (!acceptUrl) {
    console.warn('APP_URL not set — invite email skipped, only the raw token is returned');
  }

  return { ...invite, token, acceptUrl, emailed };
}

const forbidden = (res: Response) =>
  res.status(403).json({ success: false, error: 'Insufficient permissions for this organization' } as ApiResponse);

// --- Organizations -----------------------------------------------------------

// Orgs the caller belongs to (platform admin sees all)
router.get('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const where = isPlatformAdmin(req) ? {} : { id: { in: await getOrgIds(req) } };

    const { page, limit, skip, search, paged } = paging(req);
    const scoped = {
      ...where,
      ...(search && { OR: [{ name: contains(search) }, { slug: contains(search) }] }),
    };

    const [organizations, total] = await Promise.all([
      prisma.organization.findMany({
        where: scoped,
        include: { _count: { select: { members: true, domains: true, applications: true } }, server: { select: { id: true, name: true, status: true } }, postgresServer: { select: { id: true, name: true, status: true } }, mysqlServer: { select: { id: true, name: true, status: true } } },
        orderBy: { createdAt: 'desc' },
        ...(paged && { skip, take: limit }),
      }),
      paged ? prisma.organization.count({ where: scoped }) : Promise.resolve(0),
    ]);

    const memberships = await getMemberships(req);
    const roleByOrg = new Map(memberships.map((m) => [m.organizationId, m.role]));
    const rows = organizations.map((o) => ({ ...o, myRole: roleByOrg.get(o.id) ?? null }));

    return res.json({
      success: true,
      data: paged
        ? { data: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } }
        : rows,
    } as ApiResponse);
  } catch (error) {
    console.error('Error listing organizations:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

// Create an organization — platform admin only; the creator is its first OWNER
router.post(
  '/',
  authenticateToken,
  requireRole(['ADMIN']),
  validateRequest(CreateOrgSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { name } = req.body;
      const slug = (req.body.slug as string | undefined) || slugify(name);

      const clash = await prisma.organization.findUnique({ where: { slug } });
      if (clash) {
        return res.status(400).json({ success: false, error: 'Slug already in use' } as ApiResponse);
      }

      const created = await prisma.organization.create({
        data: {
          name,
          slug,
          members: { create: { userId: req.user!.userId, role: 'OWNER' } },
        },
        select: { id: true },
      });

      // Queued, not run: a new org has no server yet, so the worker picks it up
      // the moment it is placed.
      await queueOrgProvision(created.id, { userId: req.user!.userId, trigger: 'org-create' });

      const organization = await prisma.organization.findUniqueOrThrow({
        where: { id: created.id },
        include: { _count: { select: { members: true, domains: true, applications: true } }, server: { select: { id: true, name: true, status: true } }, postgresServer: { select: { id: true, name: true, status: true } }, mysqlServer: { select: { id: true, name: true, status: true } } },
      });

      return res.status(201).json({ success: true, data: organization, message: 'Organization created' } as ApiResponse);
    } catch (error) {
      console.error('Error creating organization:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
    }
  }
);

/**
 * Place an organization on a node.
 *
 * Placement is superadmin-only and one-way in practice: cb-provision-org has
 * already created this org's OS user, home and cgroup slice on its current
 * node, so moving the row does not move the files. Re-pointing a placed org is
 * therefore refused — unplace it deliberately (or move the data first) rather
 * than silently stranding every app the tenant already has.
 */
router.put(
  '/:id/server',
  authenticateToken,
  requireRole(['SUPERADMIN']),
  validateRequest(PlacementSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = req.params.id as string;
      const { serverId } = PlacementSchema.parse(req.body);

      const org = await prisma.organization.findUnique({ where: { id }, select: { serverId: true } });
      if (!org) return res.status(404).json({ success: false, error: 'Organization not found' } as ApiResponse);

      if (serverId && org.serverId && org.serverId !== serverId) {
        return res.status(400).json({
          success: false,
          error: 'This organization is already placed on another server. Its home and apps live there — migrate them first.',
        } as ApiResponse);
      }

      if (serverId && !(await prisma.server.findUnique({ where: { id: serverId } }))) {
        return res.status(400).json({ success: false, error: 'Unknown server' } as ApiResponse);
      }

      const organization = await prisma.organization.update({
        where: { id },
        data: { serverId },
        include: {
          _count: { select: { members: true, domains: true, applications: true } },
          server: { select: { id: true, name: true, status: true } }, postgresServer: { select: { id: true, name: true, status: true } }, mysqlServer: { select: { id: true, name: true, status: true } },
        },
      });

      // Placing is what lets provisioning run. Idempotent, so re-placing on
      // the same server doubles as a repair.
      if (serverId) {
        await queueOrgProvision(id, { userId: req.user!.userId, trigger: 'placement' });
        if (OS_ISOLATION_ENABLED) organization.provisionState = 'QUEUED';
      }

      return res.json({
        success: true,
        data: organization,
        message: serverId ? 'Organization placed' : 'Organization unplaced',
      } as ApiResponse);
    } catch (error) {
      console.error('Error placing organization:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
    }
  }
);

/**
 * Place an organization on a database server, per engine. Same rule as node
 * placement: the org's login and databases live on the server it is placed on,
 * so moving or unplacing an org that already has databases there is refused
 * rather than stranding them.
 */
router.put(
  '/:id/database-server',
  authenticateToken,
  requireRole(['SUPERADMIN']),
  validateRequest(DatabasePlacementSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = req.params.id as string;
      const { engine, databaseServerId } = DatabasePlacementSchema.parse(req.body);
      const field = engine === 'POSTGRESQL' ? 'postgresServerId' : 'mysqlServerId';

      const org = await prisma.organization.findUnique({
        where: { id },
        select: { postgresServerId: true, mysqlServerId: true },
      });
      if (!org) return res.status(404).json({ success: false, error: 'Organization not found' } as ApiResponse);

      const current = org[field];
      if (current && current !== databaseServerId) {
        const inUse = await prisma.database.count({ where: { organizationId: id, databaseServerId: current } });
        if (inUse) {
          return res.status(400).json({
            success: false,
            error: `This organization has ${inUse} database(s) on its current server — move them first.`,
          } as ApiResponse);
        }
      }

      if (databaseServerId) {
        const target = await prisma.databaseServer.findUnique({ where: { id: databaseServerId }, select: { engine: true } });
        if (!target) return res.status(400).json({ success: false, error: 'Unknown database server' } as ApiResponse);
        if (target.engine !== engine) {
          return res.status(400).json({ success: false, error: `That database server is not ${engine}` } as ApiResponse);
        }
      }

      const organization = await prisma.organization.update({
        where: { id },
        data: { [field]: databaseServerId },
        include: {
          _count: { select: { members: true, domains: true, applications: true } },
          server: { select: { id: true, name: true, status: true } }, postgresServer: { select: { id: true, name: true, status: true } }, mysqlServer: { select: { id: true, name: true, status: true } },
        },
      });

      return res.json({
        success: true,
        data: organization,
        message: databaseServerId ? 'Database server placed' : 'Database server unplaced',
      } as ApiResponse);
    } catch (error) {
      console.error('Error placing organization on a database server:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
    }
  }
);

// --- Members -----------------------------------------------------------------

// Single organization (detail page)
router.get('/:id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    if (!isPlatformAdmin(req) && !(await getOrgIds(req)).includes(id)) return forbidden(res);

    const organization = await prisma.organization.findUnique({
      where: { id },
      include: { _count: { select: { members: true, domains: true, applications: true } }, server: { select: { id: true, name: true, status: true } }, postgresServer: { select: { id: true, name: true, status: true } }, mysqlServer: { select: { id: true, name: true, status: true } } },
    });
    if (!organization) {
      return res.status(404).json({ success: false, error: 'Organization not found' } as ApiResponse);
    }

    const memberships = await getMemberships(req);
    const myRole = memberships.find((m) => m.organizationId === id)?.role ?? null;

    return res.json({ success: true, data: { ...organization, myRole } } as ApiResponse);
  } catch (error) {
    console.error('Error fetching organization:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

// Add an existing account to the org straight away — no invite round-trip
router.post(
  '/:id/members',
  authenticateToken,
  validateRequest(AddMemberSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = req.params.id as string;
      const email = String(req.body.email).trim().toLowerCase();
      const role = (req.body.role as 'OWNER' | 'ADMIN' | 'MEMBER') || 'MEMBER';

      if (!(await canManageOrg(req, id))) return forbidden(res);

      const organization = await prisma.organization.findUnique({ where: { id } });
      if (!organization) {
        return res.status(404).json({ success: false, error: 'Organization not found' } as ApiResponse);
      }

      const user = await prisma.user.findUnique({ where: { email } });

      // no account yet — issue the invite here instead of bouncing the admin to another form
      if (!user) {
        const invite = await issueInvite(id, email, role, req.user!.userId);
        return res.status(201).json({
          success: true,
          data: { invited: true, invite },
          message: 'No account yet — an invite was created. Send the link; it is shown only once.',
        } as ApiResponse);
      }

      const existing = await prisma.membership.findUnique({
        where: { userId_organizationId: { userId: user.id, organizationId: id } },
      });
      if (existing) {
        return res.status(400).json({ success: false, error: 'User is already a member' } as ApiResponse);
      }

      const membership = await prisma.membership.create({
        data: { userId: user.id, organizationId: id, role },
        include: { user: { select: { id: true, email: true, name: true, isActive: true } } },
      });

      return res.status(201).json({ success: true, data: membership, message: 'Member added' } as ApiResponse);
    } catch (error) {
      console.error('Error adding member:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
    }
  }
);

router.get('/:id/members', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    // any member may see the roster
    if (!isPlatformAdmin(req) && !(await getOrgIds(req)).includes(id)) return forbidden(res);

    const members = await prisma.membership.findMany({
      where: { organizationId: id },
      include: { user: { select: { id: true, email: true, name: true, isActive: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return res.json({ success: true, data: members } as ApiResponse);
  } catch (error) {
    console.error('Error listing members:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

router.put(
  '/:id/members/:userId',
  authenticateToken,
  validateRequest(MemberRoleSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = req.params.id as string;
      const userId = req.params.userId as string;
      const { role } = req.body;

      if (!(await canManageOrg(req, id))) return forbidden(res);

      // never strip the last OWNER — the org would become unmanageable
      if (role !== 'OWNER') {
        const owners = await prisma.membership.count({ where: { organizationId: id, role: 'OWNER' } });
        const target = await prisma.membership.findUnique({
          where: { userId_organizationId: { userId, organizationId: id } },
        });
        if (owners <= 1 && target?.role === 'OWNER') {
          return res.status(400).json({ success: false, error: 'Organization must keep at least one owner' } as ApiResponse);
        }
      }

      const membership = await prisma.membership.update({
        where: { userId_organizationId: { userId, organizationId: id } },
        data: { role },
        include: { user: { select: { id: true, email: true, name: true } } },
      });

      return res.json({ success: true, data: membership, message: 'Member updated' } as ApiResponse);
    } catch (error) {
      console.error('Error updating member:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
    }
  }
);

router.delete('/:id/members/:userId', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const userId = req.params.userId as string;

    if (!(await canManageOrg(req, id))) return forbidden(res);

    const target = await prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId: id } },
    });
    if (!target) {
      return res.status(404).json({ success: false, error: 'Member not found' } as ApiResponse);
    }

    if (target.role === 'OWNER') {
      const owners = await prisma.membership.count({ where: { organizationId: id, role: 'OWNER' } });
      if (owners <= 1) {
        return res.status(400).json({ success: false, error: 'Organization must keep at least one owner' } as ApiResponse);
      }
    }

    await prisma.membership.delete({ where: { userId_organizationId: { userId, organizationId: id } } });

    return res.json({ success: true, message: 'Member removed' } as ApiResponse);
  } catch (error) {
    console.error('Error removing member:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

// --- Invites -----------------------------------------------------------------

router.get('/:id/invites', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    if (!(await canManageOrg(req, id))) return forbidden(res);

    const invites = await prisma.invite.findMany({
      where: { organizationId: id },
      // tokenHash is deliberately not selected — the raw token is shown once, at creation
      select: { id: true, email: true, role: true, expiresAt: true, acceptedAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ success: true, data: invites } as ApiResponse);
  } catch (error) {
    console.error('Error listing invites:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/**
 * Invite someone to the organization.
 * Returns the raw token exactly once — it is stored hashed, so it cannot be re-read later.
 */
router.post(
  '/:id/invites',
  authenticateToken,
  validateRequest(InviteSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = req.params.id as string;
      const email = String(req.body.email).trim().toLowerCase();
      const role = (req.body.role as 'OWNER' | 'ADMIN' | 'MEMBER') || 'MEMBER';

      if (!(await canManageOrg(req, id))) return forbidden(res);

      const organization = await prisma.organization.findUnique({ where: { id } });
      if (!organization) {
        return res.status(404).json({ success: false, error: 'Organization not found' } as ApiResponse);
      }

      // an account that already exists joins straight away — no link to pass around
      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) {
        const membership = await prisma.membership.findUnique({
          where: { userId_organizationId: { userId: existingUser.id, organizationId: id } },
        });
        if (membership) {
          return res.status(400).json({ success: false, error: 'User is already a member' } as ApiResponse);
        }

        const created = await prisma.membership.create({
          data: { userId: existingUser.id, organizationId: id, role },
          include: { user: { select: { id: true, email: true, name: true, isActive: true } } },
        });

        return res.status(201).json({
          success: true,
          data: { added: true, membership: created },
          message: 'That account already exists — added to the organization directly.',
        } as ApiResponse);
      }

      const invite = await issueInvite(id, email, role, req.user!.userId);

      return res.status(201).json({
        success: true,
        data: invite,
        message: 'Invite created. Send this link to the invitee — the token is not retrievable later.',
      } as ApiResponse);
    } catch (error) {
      console.error('Error creating invite:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
    }
  }
);

router.delete('/:id/invites/:inviteId', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const inviteId = req.params.inviteId as string;

    if (!(await canManageOrg(req, id))) return forbidden(res);

    await prisma.invite.deleteMany({ where: { id: inviteId, organizationId: id } });

    return res.json({ success: true, message: 'Invite revoked' } as ApiResponse);
  } catch (error) {
    console.error('Error revoking invite:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

export default router;
