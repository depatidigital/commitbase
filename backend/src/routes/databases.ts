import { Router, Response } from 'express';
import fs from 'fs';
import os from 'os';
import multer from 'multer';
import { prisma } from '../lib/prisma';
import { CreateDatabaseSchema, ApiResponse } from '../types';
import { validateRequest } from '../middleware/validation';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { canManageOrg, isPlatformAdmin, orgScope } from '../lib/scope';
import { paging, paginated, contains } from '../lib/paging';
import { readEnv, sealEnv } from '../lib/appEnv';
import { serverForApplication } from '../lib/servers';
import { testDatabaseUrl } from '../services/databaseServerService';
import {
  ProvisionError,
  databaseCredentials,
  databaseName,
  dropDatabase,
  grantAccess,
  ownerRoleName,
  provisionDatabase,
  resolveAccount,
} from '../services/databaseProvisionService';
import {
  ImportError,
  importRunning,
  listImports,
  releaseImport,
  reserveImport,
  runImport,
  tableCount,
} from '../services/databaseImportService';

const router = Router();

const IMPORT_MAX_MB = Math.max(1, Number(process.env.DB_IMPORT_MAX_MB) || 512);
// on disk, not in memory: dumps are big. Deleted once the import is done.
const importUpload = multer({ dest: os.tmpdir(), limits: { fileSize: IMPORT_MAX_MB * 1024 * 1024, files: 1 } });

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

    // The databases the app's env points at, by name — a database shared by two
    // apps stays linked to the first one only, and this is how the second finds it.
    const env = readEnv(application.envVars);
    const names = new Set<string>();
    for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
      try {
        const name = decodeURIComponent(new URL(env[key] ?? '').pathname.replace(/^\/+/, ''));
        if (name) names.add(name);
      } catch {
        // not a URL
      }
    }
    for (const key of ['DB_DATABASE', 'PGDATABASE']) if (env[key]) names.add(env[key]!);

    const databases = await prisma.database.findMany({
      where: {
        OR: [
          { applicationId: appId },
          ...(names.size && application.organizationId
            ? [{ dbName: { in: [...names] }, organizationId: application.organizationId }]
            : []),
        ],
      },
      include: { databaseServer: { select: { id: true, name: true, engine: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({
      success: true,
      // inUse: the app's env names it — the one its code actually talks to
      data: databases.map(({ connectionString: _, ...db }) => ({ ...db, inUse: !!db.dbName && names.has(db.dbName) })),
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
/**
 * Servers a database can be created on, for the "connect a database" dialog:
 * every online one (anyone who manages an organization may pick any). Names
 * and engines only — hosts and admin logins stay with the superadmin pages.
 * `default`: the organization's own server for that engine.
 */
router.get('/servers', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId = String(req.query.organizationId ?? '');
    const org = organizationId
      ? await prisma.organization.findUnique({ where: { id: organizationId }, select: { postgresServerId: true, mysqlServerId: true } })
      : null;
    const servers = await prisma.databaseServer.findMany({
      where: { status: 'ONLINE' },
      select: { id: true, name: true, engine: true, version: true },
      orderBy: { name: 'asc' },
    });
    return res.json({
      success: true,
      data: servers.map((s) => ({ ...s, default: !!org && (s.id === org.postgresServerId || s.id === org.mysqlServerId) })),
    } as ApiResponse);
  } catch (error) {
    console.error('List database server choices error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/** An organization's logins on one server, with how many databases each reaches. Managers only. */
router.get('/logins', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId = String(req.query.organizationId ?? '');
    const databaseServerId = String(req.query.databaseServerId ?? '');
    if (!organizationId || !databaseServerId) {
      return res.status(400).json({ success: false, error: 'organizationId and databaseServerId are required' } as ApiResponse);
    }
    if (!(await canManageOrg(req, organizationId))) {
      return res.status(403).json({ success: false, error: 'Only owners and admins of the organization can see its logins' } as ApiResponse);
    }
    const [accounts, organization] = await Promise.all([
      prisma.orgDatabaseAccount.findMany({
        where: { organizationId, databaseServerId },
        select: { id: true, username: true, createdAt: true, grants: { select: { database: { select: { id: true, dbName: true } } } } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.organization.findUnique({ where: { id: organizationId }, select: { slug: true } }),
    ]);
    return res.json({
      success: true,
      data: {
        // what a new login's name starts with (accountName)
        prefix: `${(organization?.slug ?? '').replace(/-/g, '_')}_`,
        logins: accounts.map(({ grants, ...account }) => ({ ...account, databases: grants.map((g) => g.database) })),
      },
    } as ApiResponse);
  } catch (error) {
    console.error('List database logins error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/**
 * Does this database URL work from where the app runs? Dialled from the app's
 * node with the URL's own credentials (testDatabaseUrl). The value is the one
 * being edited when given, else the saved variable `key`. Managers only: it
 * makes the node dial an address the caller chose.
 */
router.post('/test-url', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const application = await prisma.application.findFirst({
      where: { id: String(req.body?.applicationId ?? ''), ...(await orgScope(req)) },
      select: { id: true, organizationId: true, envVars: true },
    });
    if (!application) return res.status(404).json({ success: false, error: 'Application not found' } as ApiResponse);
    if (!(application.organizationId ? await canManageOrg(req, application.organizationId) : isPlatformAdmin(req))) {
      return res.status(403).json({ success: false, error: 'Only owners and admins of the organization can test connections' } as ApiResponse);
    }

    const value = typeof req.body?.value === 'string' && req.body.value.trim()
      ? req.body.value.trim()
      : readEnv(application.envVars)[String(req.body?.key ?? '')];
    if (!value) return res.status(400).json({ success: false, error: 'Nothing to test — the variable is empty' } as ApiResponse);

    const node = await serverForApplication(application.id).catch(() => null);
    if (!node) return res.status(400).json({ success: false, error: 'The app has no server to test from yet' } as ApiResponse);

    const result = await testDatabaseUrl(node, value);
    return res.json({ success: true, data: result } as ApiResponse);
  } catch (error) {
    console.error('Test database URL error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

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
    const { name, type: requestedType, databaseServerId, login, organizationId: requestedOrg, applicationId } =
      CreateDatabaseSchema.parse(req.body);

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
      select: { id: true, slug: true, postgresServerId: true, mysqlServerId: true },
    });
    if (!organization) return res.status(404).json({ success: false, error: 'Organization not found' } as ApiResponse);

    // Any server may be chosen; without one, the organization's server for the
    // engine. The engine then comes from the server.
    const serverId =
      databaseServerId ??
      (requestedType === 'POSTGRESQL' ? organization.postgresServerId : requestedType === 'MYSQL' ? organization.mysqlServerId : null);
    if (!serverId) {
      return res.status(400).json({
        success: false,
        error: requestedType && requestedType !== 'POSTGRESQL' && requestedType !== 'MYSQL'
          ? `${requestedType} databases are not supported yet`
          : 'Choose a database server — this organization has no default one for that engine',
      } as ApiResponse);
    }
    const dbs = await prisma.databaseServer.findUnique({ where: { id: serverId }, include: { server: true } });
    if (!dbs) return res.status(404).json({ success: false, error: 'Database server not found' } as ApiResponse);
    if (dbs.status !== 'ONLINE') {
      return res.status(400).json({ success: false, error: `${dbs.name} is not online — choose another server or test it first` } as ApiResponse);
    }
    const type = dbs.engine as 'POSTGRESQL' | 'MYSQL';

    const dbName = databaseName(organization.slug, name, type);
    // resolved (and a new one checked against the server) before anything is recorded
    const account = await resolveAccount(dbs, organization, login);

    let database;
    try {
      database = await prisma.database.create({
        data: {
          name,
          type,
          status: 'CREATING',
          dbName,
          port: dbs.port,
          organizationId,
          databaseServerId: dbs.id,
          ...(type === 'POSTGRESQL' && { ownerRole: ownerRoleName(dbName) }),
          grants: { create: { accountId: account.id } },
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
      // accountId: the login it was made with, for the attach that follows
      data: fresh && { ...fresh, accountId: account.id },
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

    // which login the app connects as: one the org has, a new one, or (none
    // given) the login the database already has
    const parsedLogin = CreateDatabaseSchema.shape.login.safeParse(req.body?.login);
    if (!parsedLogin.success) return res.status(400).json({ success: false, error: 'Invalid login' } as ApiResponse);
    let accountId: string | undefined;
    if (parsedLogin.data) {
      const full = await prisma.database.findUnique({
        where: { id: database.id },
        include: { databaseServer: { include: { server: true } }, organization: { select: { id: true, slug: true } } },
      });
      if (!full?.databaseServer || !full.organization) {
        return res.status(400).json({ success: false, error: 'This database has no server or organization to add a login on' } as ApiResponse);
      }
      accountId = (await resolveAccount(full.databaseServer, full.organization, parsedLogin.data)).id;
      const granted = await grantAccess(database.id, accountId);
      if (!granted.ok) {
        return res.status(502).json({ success: false, error: `Could not give the login access on the server: ${granted.error}` } as ApiResponse);
      }
    }

    // the host as the app's own node reaches it: loopback when it shares the
    // database's node, an address other nodes can reach otherwise
    const appNode = await serverForApplication(application.id).catch(() => null);
    const credentials = await databaseCredentials(database.id, accountId, appNode?.id ?? null);
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

/** A database an import may run in: manageable, created by the panel, and up. The error to send otherwise. */
async function importable(req: AuthenticatedRequest, id: string) {
  const database = await manageable(req, id);
  if (!database) return { status: 404, error: 'Database not found' } as const;
  if (database.discovered) {
    return { status: 400, error: 'This database was imported from its server — the panel holds no login for it' } as const;
  }
  if (database.status !== 'RUNNING' || !database.dbName) return { status: 400, error: 'The database is not ready yet' } as const;
  return { database };
}

// How many tables it has: an import into a non-empty database is confirmed by name.
router.get('/:id/tables', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const found = await importable(req, req.params.id as string);
    if (!('database' in found)) return res.status(found.status).json({ success: false, error: found.error } as ApiResponse);
    return res.json({ success: true, data: { tables: await tableCount(found.database.id) } } as ApiResponse);
  } catch (error: any) {
    if (error instanceof ProvisionError || error instanceof ImportError) {
      return res.status(400).json({ success: false, error: error.message } as ApiResponse);
    }
    console.error('Count database tables error:', error);
    return res.status(502).json({ success: false, error: `Could not reach the database: ${error?.message ?? 'failed'}` } as ApiResponse);
  }
});

// The latest imports, with the live log of a running one — polled by the import dialog.
router.get('/:id/imports', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const database = await manageable(req, req.params.id as string);
    if (!database) return res.status(404).json({ success: false, error: 'Database not found' } as ApiResponse);
    return res.json({ success: true, data: await listImports(database.id) } as ApiResponse);
  } catch (error) {
    console.error('List database imports error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/**
 * Run an uploaded .sql / .sql.gz (field `file`) in this database, as its own
 * login (databaseImportService). Everything is checked before the upload is
 * accepted; into a database that already has tables only with
 * `?confirm=<dbName>`. Answers 202 with the import row — the run carries on
 * in the background, followed through GET /:id/imports.
 */
router.post('/:id/import', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  const found = await importable(req, req.params.id as string).catch(() => null);
  if (!found) return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  if (!('database' in found)) return res.status(found.status).json({ success: false, error: found.error } as ApiResponse);
  const { database } = found;

  if (!reserveImport(database.id)) {
    return res.status(409).json({ success: false, error: 'An import is already running in this database' } as ApiResponse);
  }
  let started = false;
  try {
    const tables = await tableCount(database.id);
    if (tables > 0 && req.query.confirm !== database.dbName) {
      return res.status(400).json({
        success: false,
        error: `${database.dbName} already has ${tables} tables — type its name to import into it anyway`,
      } as ApiResponse);
    }

    await new Promise<void>((resolve, reject) => importUpload.single('file')(req, res, (error) => (error ? reject(error) : resolve())));
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' } as ApiResponse);

    const row = await prisma.databaseImport.create({
      data: {
        databaseId: database.id,
        userId: req.user!.userId,
        fileName: req.file.originalname.slice(0, 200),
        sizeBytes: req.file.size,
      },
    });
    started = true;
    // releases the database and deletes the file when done
    void runImport(row.id, database.id, req.file.path);
    return res.status(202).json({ success: true, data: row, message: 'Import started' } as ApiResponse);
  } catch (error: any) {
    if (error instanceof multer.MulterError) {
      const tooBig = error.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({
        success: false,
        error: tooBig ? `The file is larger than ${IMPORT_MAX_MB} MB — gzip it, or split it` : error.message,
      } as ApiResponse);
    }
    if (error instanceof ProvisionError || error instanceof ImportError) {
      return res.status(400).json({ success: false, error: error.message } as ApiResponse);
    }
    console.error('Start database import error:', error);
    return res.status(502).json({ success: false, error: `Could not start the import: ${error?.message ?? 'failed'}` } as ApiResponse);
  } finally {
    if (!started) {
      releaseImport(database.id);
      if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    }
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

    if (importRunning(database.id)) {
      return res.status(409).json({ success: false, error: 'An import is running in this database — wait for it to finish' } as ApiResponse);
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
