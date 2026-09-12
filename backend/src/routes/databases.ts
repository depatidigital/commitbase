import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { CreateDatabaseSchema, ApiResponse } from '../types';
import { validateRequest } from '../middleware/validation';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { canManageOrg, isPlatformAdmin, orgScope } from '../lib/scope';
import { paging, paginated, contains } from '../lib/paging';
import { readEnv, sealEnv } from '../lib/appEnv';
import {
  ProvisionError,
  databaseCredentials,
  databaseName,
  dropDatabase,
  provisionDatabase,
} from '../services/databaseProvisionService';

const router = Router();

/**
 * Who may see a database: members of the org that owns it, or of the org its
 * app belongs to (rows from before databases had an owner of their own).
 */
async function databaseScope(req: AuthenticatedRequest) {
  const scope = await orgScope(req);
  return 'organizationId' in scope ? { OR: [scope, { application: scope }] } : {};
}

// Get databases for an application
// All databases across the caller's organizations
router.get('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, limit, skip, search, paged, organizationId } = paging(req);
    const and: any[] = [await databaseScope(req)];
    if (organizationId) and.push({ OR: [{ organizationId }, { application: { organizationId } }] });
    if (search) and.push({ OR: [{ name: contains(search) }, { application: { name: contains(search) } }] });
    const where = { AND: and };

    const [databases, total] = await Promise.all([
      prisma.database.findMany({
        where,
        include: {
          application: {
            select: {
              id: true,
              name: true,
              domain: true,
              organization: { select: { id: true, name: true, slug: true } },
            },
          },
          organization: { select: { id: true, name: true, slug: true } },
          databaseServer: { select: { id: true, name: true, engine: true } },
        },
        orderBy: { createdAt: 'desc' },
        ...(paged && { skip, take: limit }),
      }),
      paged ? prisma.database.count({ where }) : Promise.resolve(0),
    ]);

    return res.json(
      (paged ? paginated(databases, total, page, limit) : { success: true, data: databases }) as ApiResponse
    );
  } catch (error) {
    console.error('List databases error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

router.get('/application/:appId', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { appId } = req.params;

    if (!appId) {
      return res.status(400).json({
        success: false,
        error: 'Application ID is required',
      } as ApiResponse);
    }

    // Verify application belongs to user
    const application = await prisma.application.findFirst({
      where: {
        id: appId,
        ...(await orgScope(req)),
      },
    });

    if (!application) {
      return res.status(404).json({
        success: false,
        error: 'Application not found',
      } as ApiResponse);
    }

    const databases = await prisma.database.findMany({
      where: {
        applicationId: appId,
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({
      success: true,
      data: databases,
    } as ApiResponse);
  } catch (error) {
    console.error('Get databases error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Get single database
router.get('/:id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Database ID is required',
      } as ApiResponse);
    }

    const database = await prisma.database.findFirst({
      where: {
        id: id as string,
        ...(await databaseScope(req)),
      },
      include: {
        application: true,
      },
    });

    if (!database) {
      return res.status(404).json({
        success: false,
        error: 'Database not found',
      } as ApiResponse);
    }

    return res.json({
      success: true,
      data: database,
    } as ApiResponse);
  } catch (error) {
    console.error('Get database error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Create new database
router.post('/', authenticateToken, validateRequest(CreateDatabaseSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, type, organizationId: requestedOrg, applicationId } = CreateDatabaseSchema.parse(req.body);

    if (type !== 'POSTGRESQL' && type !== 'MYSQL') {
      return res.status(400).json({ success: false, error: `${type} databases are not supported yet` } as ApiResponse);
    }

    // The owner is the app's organization, or the one asked for. Either way the
    // caller has to be able to manage it — a database is that org's resource.
    let organizationId = requestedOrg ?? null;
    if (applicationId) {
      const application = await prisma.application.findFirst({
        where: { id: applicationId, ...(await orgScope(req)) },
        select: { organizationId: true },
      });
      if (!application) return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
      if (!application.organizationId) {
        return res.status(400).json({ success: false, error: 'Assign the app to an organization first' } as ApiResponse);
      }
      organizationId = application.organizationId;
    }
    if (!organizationId) {
      return res.status(400).json({ success: false, error: 'Choose the organization the database belongs to' } as ApiResponse);
    }
    if (!(await canManageOrg(req, organizationId))) {
      return res.status(403).json({ success: false, error: 'Only owners and admins of the organization can create databases' } as ApiResponse);
    }

    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      include: { postgresServer: { select: { id: true, port: true } }, mysqlServer: { select: { id: true, port: true } } },
    });
    if (!organization) return res.status(404).json({ success: false, error: 'Organization not found' } as ApiResponse);

    const placed = type === 'POSTGRESQL' ? organization.postgresServer : organization.mysqlServer;
    if (!placed) {
      return res.status(400).json({
        success: false,
        error: `This organization is not placed on a ${type === 'POSTGRESQL' ? 'PostgreSQL' : 'MySQL'} server yet — a superadmin sets that on the organization page`,
      } as ApiResponse);
    }

    const dbName = databaseName(organization.slug, name, type);

    let database;
    try {
      database = await prisma.database.create({
        data: {
          name,
          type,
          status: 'CREATING',
          dbName,
          port: placed.port,
          organizationId,
          databaseServerId: placed.id,
          ...(applicationId && { applicationId }),
        },
      });
    } catch (error: any) {
      // (databaseServerId, dbName) is unique — the name is taken on that server
      if (error?.code === 'P2002') {
        return res.status(409).json({ success: false, error: `A database named ${dbName} already exists on that server` } as ApiResponse);
      }
      throw error;
    }

    const result = await provisionDatabase(database.id);
    const fresh = await prisma.database.findUnique({ where: { id: database.id } });

    return res.status(result.ok ? 201 : 502).json({
      success: result.ok,
      data: fresh,
      ...(result.ok
        ? { message: `Database ${dbName} created` }
        : { error: `The database was recorded but could not be created on the server: ${result.error}` }),
    } as ApiResponse);
  } catch (error) {
    if (error instanceof ProvisionError) {
      return res.status(400).json({ success: false, error: error.message } as ApiResponse);
    }
    console.error('Create database error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

/** A database the caller may manage (owner/admin of its org, or a platform admin), or null. */
async function manageable(req: AuthenticatedRequest, id: string) {
  const database = await prisma.database.findFirst({
    where: { id, ...(await databaseScope(req)) },
    include: { application: { select: { organizationId: true } } },
  });
  if (!database) return null;
  const ownerOrg = database.organizationId ?? database.application?.organizationId ?? null;
  const allowed = ownerOrg ? await canManageOrg(req, ownerOrg) : isPlatformAdmin(req);
  return allowed ? database : null;
}

type Credentials = Awaited<ReturnType<typeof databaseCredentials>>;

/**
 * The other names apps read a database from, and what goes in each: Prisma's
 * DIRECT_URL (no pooler here, so the same URL), Vercel-style POSTGRES_*,
 * Laravel's DB_*, libpq's PG*. Mirrored by the frontend's DATABASE_KEYS.
 */
const DB_ENV: Record<string, (c: Credentials) => string | null> = {
  DIRECT_URL: (c) => c.url,
  POSTGRES_URL: (c) => (c.engine === 'POSTGRESQL' ? c.url : null),
  POSTGRES_PRISMA_URL: (c) => (c.engine === 'POSTGRESQL' ? c.url : null),
  POSTGRES_URL_NON_POOLING: (c) => (c.engine === 'POSTGRESQL' ? c.url : null),
  DB_CONNECTION: (c) => (c.engine === 'POSTGRESQL' ? 'pgsql' : 'mysql'),
  DB_HOST: (c) => c.host,
  DB_PORT: (c) => String(c.port),
  DB_DATABASE: (c) => c.database,
  DB_USERNAME: (c) => c.username,
  DB_PASSWORD: (c) => c.password,
  PGHOST: (c) => (c.engine === 'POSTGRESQL' ? c.host : null),
  PGPORT: (c) => (c.engine === 'POSTGRESQL' ? String(c.port) : null),
  PGDATABASE: (c) => (c.engine === 'POSTGRESQL' ? c.database : null),
  PGUSER: (c) => (c.engine === 'POSTGRESQL' ? c.username : null),
  PGPASSWORD: (c) => (c.engine === 'POSTGRESQL' ? c.password : null),
};

/**
 * Connect a database to an app: link it, and put its connection URL in the
 * app's env under `envKey` (DATABASE_URL) — plus whichever of the DB_ENV names
 * the app uses (`alsoKeys`, the ones in its form). Values go from the
 * credentials store straight into the encrypted env, never through the browser.
 * Both "create new" (POST / with applicationId, then this) and "use existing".
 */
router.post('/:id/attach', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const envKey = String(req.body?.envKey || 'DATABASE_URL').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) {
      return res.status(400).json({ success: false, error: 'Invalid variable name' } as ApiResponse);
    }

    const database = await manageable(req, req.params.id as string);
    if (!database) return res.status(404).json({ success: false, error: 'Database not found' } as ApiResponse);

    const application = await prisma.application.findFirst({
      where: { id: String(req.body?.applicationId ?? ''), ...(await orgScope(req)) },
      select: { id: true, organizationId: true, envVars: true },
    });
    if (!application) return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);

    const ownerOrg = database.organizationId ?? database.application?.organizationId ?? null;
    if (ownerOrg && application.organizationId !== ownerOrg) {
      return res.status(400).json({ success: false, error: 'That database belongs to another organization' } as ApiResponse);
    }

    const credentials = await databaseCredentials(database.id);
    // only names from the list, and only for this engine — never an arbitrary key
    const also = (Array.isArray(req.body?.alsoKeys) ? req.body.alsoKeys : [])
      .map(String)
      .filter((key: string) => key !== envKey && key in DB_ENV);
    const filled: Record<string, string> = { [envKey]: credentials.url };
    for (const key of also) {
      const value = DB_ENV[key]!(credentials);
      if (value !== null) filled[key] = value;
    }

    await prisma.$transaction([
      // a database already used by another app stays linked there; two apps may share one
      ...(database.applicationId ? [] : [prisma.database.update({ where: { id: database.id }, data: { applicationId: application.id } })]),
      prisma.application.update({
        where: { id: application.id },
        data: { envVars: sealEnv({ ...readEnv(application.envVars), ...filled }) },
      }),
      prisma.log.create({
        data: {
          level: 'INFO',
          message: `Credentials of database ${credentials.database} written to ${Object.keys(filled).join(', ')}`,
          userId: req.user!.userId,
          applicationId: application.id,
          metadata: { databaseId: database.id, username: credentials.username, keys: Object.keys(filled) },
        },
      }),
    ]);

    return res.json({ success: true, data: { envKey, keys: Object.keys(filled), database: credentials.database } } as ApiResponse);
  } catch (error) {
    if (error instanceof ProvisionError) {
      return res.status(400).json({ success: false, error: error.message } as ApiResponse);
    }
    console.error('Attach database error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

// Retry a create that failed on the server. Safe to repeat.
router.post('/:id/provision', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const database = await manageable(req, req.params.id as string);
    if (!database) return res.status(404).json({ success: false, error: 'Database not found' } as ApiResponse);
    if (database.discovered) {
      return res.status(400).json({ success: false, error: 'An imported database is not provisioned by the panel' } as ApiResponse);
    }

    const result = await provisionDatabase(database.id);
    const fresh = await prisma.database.findUnique({ where: { id: database.id } });
    return res.status(result.ok ? 200 : 502).json({
      success: result.ok,
      data: fresh,
      ...(result.ok ? { message: 'Database is ready' } : { error: result.error }),
    } as ApiResponse);
  } catch (error) {
    if (error instanceof ProvisionError) {
      return res.status(400).json({ success: false, error: error.message } as ApiResponse);
    }
    console.error('Provision database error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

// The password, for the people who manage the org. Every read is logged.
router.get('/:id/credentials', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const database = await manageable(req, req.params.id as string);
    if (!database) return res.status(404).json({ success: false, error: 'Database not found' } as ApiResponse);

    const credentials = await databaseCredentials(database.id);
    await prisma.log.create({
      data: {
        level: 'INFO',
        message: `Credentials revealed for database ${credentials.database}`,
        userId: req.user!.userId,
        applicationId: database.applicationId,
        metadata: { databaseId: database.id, username: credentials.username },
      },
    });

    return res.json({ success: true, data: credentials } as ApiResponse);
  } catch (error) {
    if (error instanceof ProvisionError) {
      return res.status(400).json({ success: false, error: error.message } as ApiResponse);
    }
    console.error('Database credentials error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

// Delete database
router.delete('/:id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Database ID is required',
      } as ApiResponse);
    }

    const database = await prisma.database.findFirst({
      where: {
        id: id as string,
        ...(await databaseScope(req)),
      },
      include: { application: { select: { organizationId: true } } },
    });

    if (!database) {
      return res.status(404).json({
        success: false,
        error: 'Database not found',
      } as ApiResponse);
    }

    const ownerOrg = database.organizationId ?? database.application?.organizationId ?? null;
    if (ownerOrg ? !(await canManageOrg(req, ownerOrg)) : !isPlatformAdmin(req)) {
      return res.status(403).json({ success: false, error: 'Only owners and admins of the organization can delete databases' } as ApiResponse);
    }

    // An imported database is data someone else created: the panel only forgets
    // it (a superadmin's call), and the next sync lists it again, unassigned.
    if (database.discovered && !isPlatformAdmin(req)) {
      return res.status(403).json({
        success: false,
        error: 'This database was imported from its server — ask an administrator to remove it',
      } as ApiResponse);
    }

    // Dropping real data is typed out, not clicked through.
    if (!database.discovered && database.dbName && req.body?.confirm !== database.dbName) {
      return res.status(400).json({ success: false, error: `Type ${database.dbName} to confirm` } as ApiResponse);
    }

    try {
      await dropDatabase(database.id);
    } catch (error: any) {
      return res.status(502).json({
        success: false,
        error: `Could not drop the database on its server: ${error?.message ?? 'failed'}`,
      } as ApiResponse);
    }

    await prisma.database.delete({
      where: { id: id as string },
    });

    return res.json({
      success: true,
      message: database.discovered ? 'Database removed from the panel' : 'Database deleted',
    } as ApiResponse);
  } catch (error) {
    console.error('Delete database error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

export default router; 
