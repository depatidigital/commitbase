import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { CreateDatabaseSchema, ApiResponse } from '../types';
import { validateRequest } from '../middleware/validation';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { orgScope } from '../lib/scope';
import { paging, paginated, contains } from '../lib/paging';

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
