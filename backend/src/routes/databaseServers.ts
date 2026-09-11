import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiResponse } from '../types';
import { validateRequest } from '../middleware/validation';
import { authenticateToken, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { paging, contains } from '../lib/paging';
import { canEncrypt, encrypt } from '../lib/secretBox';
import { checkDatabaseServer } from '../services/databaseServerService';

const router = Router();

/**
 * Database servers — the Postgres/MySQL instances tenant databases live on.
 * Superadmin only: the admin credential stored here can create a login and a
 * database for any tenant on that server.
 */

const DatabaseServerSchema = z.object({
  name: z.string().trim().min(2).max(60),
  engine: z.enum(['POSTGRESQL', 'MYSQL']),
  mode: z.enum(['TUNNEL', 'DIRECT']).default('TUNNEL'),
  serverId: z.string().min(1).nullable().optional(),
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535),
  tlsMode: z.enum(['DISABLE', 'REQUIRE', 'VERIFY']).default('REQUIRE'),
  caCert: z.string().trim().max(20_000).nullable().optional(),
  adminUser: z.string().trim().min(1).max(63),
  adminPassword: z.string().min(1).max(512),
  appHost: z.string().trim().min(1).max(255),
});

// on update the password is optional: omitted means keep the stored one
const UpdateDatabaseServerSchema = DatabaseServerSchema.partial();

type Shape = {
  mode: string;
  serverId?: string | null | undefined;
  tlsMode: string;
  caCert?: string | null | undefined;
};

/**
 * Rules that span fields. A tunnelled server needs its node; a direct one
 * crosses networks we do not own, so it never goes without TLS.
 */
async function shapeError(shape: Shape): Promise<string | null> {
  if (shape.mode === 'TUNNEL') {
    if (!shape.serverId) return 'A tunnelled database server needs the node it runs on';
    if (!(await prisma.server.findUnique({ where: { id: shape.serverId }, select: { id: true } }))) {
      return 'Unknown node';
    }
  }
  if (shape.mode === 'DIRECT' && shape.tlsMode === 'DISABLE') {
    return 'A direct (managed) database server must use TLS';
  }
  if (shape.caCert && !shape.caCert.includes('BEGIN CERTIFICATE')) {
    return 'The CA certificate must be PEM (-----BEGIN CERTIFICATE-----)';
  }
  return null;
}

const include = {
  server: { select: { id: true, name: true, hostname: true } },
  _count: { select: { databases: true, postgresOrgs: true, mysqlOrgs: true } },
} as const;

/** The admin password is ciphertext, and still never leaves the backend. */
function redact<T extends { adminPasswordEnc?: string }>(row: T) {
  const { adminPasswordEnc, ...rest } = row;
  return { ...rest, hasPassword: !!adminPasswordEnc };
}

// List. Unpaged (optionally ?engine=) for the org-placement pickers, paged for the table.
router.get('/', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, limit, skip, search, paged } = paging(req);
    const engine = String(req.query.engine ?? '').toUpperCase();
    const where = {
      ...(search && { OR: [{ name: contains(search) }, { host: contains(search) }] }),
      ...((engine === 'POSTGRESQL' || engine === 'MYSQL') && { engine: engine as 'POSTGRESQL' | 'MYSQL' }),
    };

    const [rows, total] = await Promise.all([
      prisma.databaseServer.findMany({
        where,
        include,
        orderBy: { createdAt: 'asc' },
        ...(paged && { skip, take: limit }),
      }),
      paged ? prisma.databaseServer.count({ where }) : Promise.resolve(0),
    ]);

    return res.json({
      success: true,
      data: paged
        ? { data: rows.map(redact), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } }
        : rows.map(redact),
    } as ApiResponse);
  } catch (error) {
    console.error('Error listing database servers:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

router.get('/:id', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const row = await prisma.databaseServer.findUnique({ where: { id: req.params.id as string }, include });
    if (!row) return res.status(404).json({ success: false, error: 'Database server not found' } as ApiResponse);
    return res.json({ success: true, data: redact(row) } as ApiResponse);
  } catch (error) {
    console.error('Error fetching database server:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

// Register, then test at once so the row is never born with an unknown status.
router.post(
  '/',
  authenticateToken,
  requireRole(['SUPERADMIN']),
  validateRequest(DatabaseServerSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { adminPassword, ...data } = DatabaseServerSchema.parse(req.body);

      if (!canEncrypt()) {
        return res.status(400).json({
          success: false,
          error: 'CB_SECRET_KEY is not set, so the admin password cannot be stored',
        } as ApiResponse);
      }
      const shape = await shapeError(data);
      if (shape) return res.status(400).json({ success: false, error: shape } as ApiResponse);

      const created = await prisma.databaseServer.create({
        data: {
          ...data,
          // a direct server is not on any node of ours
          serverId: data.mode === 'TUNNEL' ? data.serverId ?? null : null,
          caCert: data.caCert || null,
          adminPasswordEnc: encrypt(adminPassword),
        },
        include: { server: true },
      });

      const check = await checkDatabaseServer(created);
      const fresh = await prisma.databaseServer.findUnique({ where: { id: created.id }, include });

      return res.status(201).json({
        success: true,
        data: fresh ? redact(fresh) : null,
        message:
          check.status === 'ONLINE'
            ? `Database server registered — ${check.inspection?.version}`
            : `Database server registered, but it could not be reached: ${check.error}`,
      } as ApiResponse);
    } catch (error) {
      console.error('Error creating database server:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
    }
  },
);

router.put(
  '/:id',
  authenticateToken,
  requireRole(['SUPERADMIN']),
  validateRequest(UpdateDatabaseServerSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = req.params.id as string;
      const { adminPassword, ...data } = UpdateDatabaseServerSchema.parse(req.body);

      const current = await prisma.databaseServer.findUnique({ where: { id } });
      if (!current) return res.status(404).json({ success: false, error: 'Database server not found' } as ApiResponse);

      // the engine is what every database on it was created with
      if (data.engine && data.engine !== current.engine) {
        return res.status(400).json({ success: false, error: 'The engine of a database server cannot change' } as ApiResponse);
      }
      if (adminPassword && !canEncrypt()) {
        return res.status(400).json({
          success: false,
          error: 'CB_SECRET_KEY is not set, so the admin password cannot be stored',
        } as ApiResponse);
      }

      const merged = {
        mode: data.mode ?? current.mode,
        serverId: data.serverId !== undefined ? data.serverId : current.serverId,
        tlsMode: data.tlsMode ?? current.tlsMode,
        caCert: data.caCert !== undefined ? data.caCert : current.caCert,
      };
      const shape = await shapeError(merged);
      if (shape) return res.status(400).json({ success: false, error: shape } as ApiResponse);

      // drop omitted keys: under exactOptionalPropertyTypes undefined is not "leave alone"
      const patch = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));

      const updated = await prisma.databaseServer.update({
        where: { id },
        data: {
          ...patch,
          serverId: merged.mode === 'TUNNEL' ? merged.serverId ?? null : null,
          ...(data.caCert !== undefined && { caCert: data.caCert || null }),
          ...(adminPassword && { adminPasswordEnc: encrypt(adminPassword) }),
        },
        include: { server: true },
      });

      // a new address or credential is only trustworthy once it has answered
      const check = await checkDatabaseServer(updated);
      const fresh = await prisma.databaseServer.findUnique({ where: { id }, include });

      return res.json({
        success: true,
        data: fresh ? redact(fresh) : null,
        message:
          check.status === 'ONLINE'
            ? 'Database server updated'
            : `Database server updated, but it could not be reached: ${check.error}`,
      } as ApiResponse);
    } catch (error) {
      console.error('Error updating database server:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
    }
  },
);

// Connection test on demand: reachability, login, version and admin rights.
router.post('/:id/test', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const row = await prisma.databaseServer.findUnique({ where: { id: req.params.id as string }, include: { server: true } });
    if (!row) return res.status(404).json({ success: false, error: 'Database server not found' } as ApiResponse);

    const check = await checkDatabaseServer(row);
    const fresh = await prisma.databaseServer.findUnique({ where: { id: row.id }, include });

    return res.json({
      success: check.status === 'ONLINE',
      data: { ...(fresh ? redact(fresh) : {}), inspection: check.inspection ?? null },
      ...(check.status === 'ONLINE' ? { message: check.inspection?.version } : { error: check.error }),
    } as ApiResponse);
  } catch (error) {
    console.error('Error testing database server:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/**
 * Removing the row does not touch the engine. Refused while anything still
 * points at it — tenant databases and logins live there, and organizations
 * placed on it would silently lose their placement.
 */
router.delete('/:id', authenticateToken, requireRole(['SUPERADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const row = await prisma.databaseServer.findUnique({
      where: { id },
      include: { _count: { select: { databases: true, accounts: true, postgresOrgs: true, mysqlOrgs: true } } },
    });
    if (!row) return res.status(404).json({ success: false, error: 'Database server not found' } as ApiResponse);

    const { databases, accounts, postgresOrgs, mysqlOrgs } = row._count;
    if (databases || accounts || postgresOrgs || mysqlOrgs) {
      return res.status(409).json({
        success: false,
        error: `Still in use: ${databases} database(s), ${accounts} organization login(s), ${postgresOrgs + mysqlOrgs} organization(s) placed on it`,
      } as ApiResponse);
    }

    await prisma.databaseServer.delete({ where: { id } });
    return res.json({ success: true, message: 'Database server removed' } as ApiResponse);
  } catch (error) {
    console.error('Error deleting database server:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

export default router;
