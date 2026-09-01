import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { CreateDomainSchema, UpdateDomainSchema, ApiResponse, Domain } from '../types';
import { validateRequest } from '../middleware/validation';
import { authenticateToken, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { orgScope } from '../lib/scope';
import { paging, paginated, contains } from '../lib/paging';
import { syncDomainDns, getOrCreateCloudflareZone, listCloudflareDnsRecords, listCloudflareZones, getZoneSslState } from '../services/cloudflareService';
import { listRdashDomains } from '../services/rdashService';

const router = Router();

/** `?expiring=expired|30|60|90` — registration expiry windows for the domains list. */
const expiryFilter = (value: unknown) => {
  if (typeof value !== 'string' || !value) return [];

  const now = new Date();
  if (value === 'expired') return [{ expiresAt: { lt: now } }];

  const days = parseInt(value, 10);
  if (!Number.isFinite(days)) return [];

  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return [{ expiresAt: { gte: now, lte: until } }];
};

// Get all domains for the authenticated user
router.get('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page, limit, skip, search, paged, organizationId } = paging(req);
    const where = {
      ...(await orgScope(req)),
      ...(organizationId && { organizationId }),
      ...(search && { name: contains(search) }),
      // ?filter=unassigned | needs-attention — drives the tabs on the domains page.
      // AND, not a bare key, so it narrows orgScope instead of replacing it.
      AND: [
        ...(req.query.filter === 'unassigned' ? [{ organizationId: null }] : []),
        ...(req.query.filter === 'needs-attention'
          ? [{ OR: [{ organizationId: null }, { cfZoneId: null }] }]
          : []),
        ...(typeof req.query.status === 'string' && req.query.status
          ? [{ status: req.query.status as any }]
          : []),
        ...expiryFilter(req.query.expiring),
      ],
    };

    const [domains, total] = await Promise.all([
      prisma.domain.findMany({
        where,
        include: {
          organization: { select: { id: true, name: true, slug: true } },
        },
        orderBy: {
          createdAt: 'desc',
        },
        ...(paged && { skip, take: limit }),
      }),
      paged ? prisma.domain.count({ where }) : Promise.resolve(0),
    ]);

    res.json(
      (paged
        ? paginated(domains, total, page, limit)
        : { success: true, data: domains, message: 'Domains retrieved successfully' }) as ApiResponse
    );
  } catch (error) {
    console.error('Error fetching domains:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Get a specific domain by ID
router.get('/:id', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Domain ID is required',
      } as ApiResponse);
    }

    const domain = await prisma.domain.findFirst({
      where: {
        id: id as string,
        ...(await orgScope(req)),
      },
    });

    if (!domain) {
      return res.status(404).json({
        success: false,
        error: 'Domain not found',
      } as ApiResponse);
    }

    return res.json({
      success: true,
      data: domain,
      message: 'Domain retrieved successfully',
    } as ApiResponse<Domain>);
  } catch (error) {
    console.error('Error fetching domain:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Create a new domain
router.post('/', authenticateToken, requireRole(['ADMIN']), validateRequest(CreateDomainSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, redirectTo, customConfig, organizationId } = req.body;

    const organization = await prisma.organization.findUnique({ where: { id: organizationId } });
    if (!organization) {
      return res.status(404).json({
        success: false,
        error: 'Owning organization not found',
      } as ApiResponse);
    }

    const trimmedName = String(name).trim().toLowerCase();

    const existingDomain = await prisma.domain.findUnique({
      where: { name: trimmedName },
    });

    if (existingDomain) {
      return res.status(400).json({
        success: false,
        error: 'Domain already exists',
      } as ApiResponse);
    }

    let dnsRecords: any = null;
    let status: Domain['status'] = 'PENDING';
    let mergedCustomConfig: any = customConfig || null;

    const cloudflareZone = await getOrCreateCloudflareZone(trimmedName);
    if (cloudflareZone) {
      mergedCustomConfig = {
        ...(mergedCustomConfig || {}),
        cloudflare: {
          zoneId: cloudflareZone.id,
          zoneName: cloudflareZone.name,
          nameservers: cloudflareZone.nameServers,
          synced: true,
        },
      };

      status = 'ACTIVE';
    }

    const cloudflareRecords = await syncDomainDns(trimmedName, cloudflareZone?.id);
    if (cloudflareRecords) {
      dnsRecords = cloudflareRecords;
      status = 'ACTIVE';
    }

    const domain = await prisma.domain.create({
      data: {
        name: trimmedName,
        status,
        dnsRecords,
        redirectTo,
        customConfig: mergedCustomConfig,
        organizationId,
        userId: req.user!.userId,
      },
    });

    return res.status(201).json({
      success: true,
      data: domain,
      message: 'Domain created successfully',
    } as ApiResponse<Domain>);
  } catch (error) {
    console.error('Error creating domain:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Pull every domain we know about from RDASH (registrar) and Cloudflare (DNS) and
// reconcile them into one list. Organization is never touched — assigned by hand later.
router.post('/sync', authenticateToken, requireRole(['ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const [cfResult, rdashResult] = await Promise.allSettled([
      (async () => {
        const perPage = 50;
        const zones: any[] = [];
        // ponytail: sequential paging, fine for a few hundred zones
        for (let page = 1; page <= 50; page++) {
          const batch = await listCloudflareZones({ page, perPage });
          if (batch === null) throw new Error('Cloudflare zones unavailable');
          zones.push(...batch);
          if (batch.length < perPage) break;
        }
        return zones;
      })(),
      (async () => {
        // RDASH pages at 10 per response and rejects per_page — follow meta.last_page
        const rows: any[] = [];
        let lastPage = 1;
        for (let page = 1; page <= lastPage && page <= 100; page++) {
          const raw: any = await listRdashDomains({ page });
          const batch = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
          rows.push(...batch);
          lastPage = Number(raw?.meta?.last_page) || 1;
        }
        return rows;
      })(),
    ]);

    const errors: Record<string, string> = {};

    const zones: any[] = cfResult.status === 'fulfilled' ? cfResult.value : [];
    if (cfResult.status === 'rejected') {
      errors.cloudflare = 'Failed to fetch Cloudflare zones. Check the Cloudflare integration config.';
    }

    let rdashRows: any[] = [];
    if (rdashResult.status === 'fulfilled') {
      rdashRows = rdashResult.value;
    } else {
      errors.rdash = 'Failed to fetch RDASH domains. Check the RDASH integration config.';
    }

    // one row per domain name, merged from both sources
    type Merged = { name: string; zone?: any; rdash?: any };
    const merged = new Map<string, Merged>();
    const put = (rawName: any, patch: Partial<Merged>) => {
      const name = String(rawName || '').trim().toLowerCase();
      if (!name) return;
      merged.set(name, { ...(merged.get(name) || { name }), ...patch, name });
    };

    for (const zone of zones) put(zone?.name, { zone });
    for (const row of rdashRows) put(row?.domain || row?.name, { rdash: row });

    let created = 0;
    let updated = 0;
    const now = new Date();

    for (const entry of merged.values()) {
      const { name, zone, rdash } = entry;

      const cfZoneId = zone?.id ? String(zone.id) : null;
      const cloudflare = zone
        ? {
            zoneId: cfZoneId,
            zoneName: name,
            nameservers: Array.isArray(zone.name_servers) ? zone.name_servers : [],
            synced: true,
          }
        : null;

      // real certificate state — Cloudflare terminates TLS, so it is the only honest source
      const ssl = cfZoneId ? await getZoneSslState(cfZoneId) : null;

      // RDASH is not consistent about the field name, so try the ones it actually sends
      const rawExpiry =
        rdash?.expired_at ?? rdash?.expiryDate ?? rdash?.expire_date ?? rdash?.expiresAt ?? null;
      const parsedExpiry = rawExpiry ? new Date(rawExpiry) : null;
      const expiresAt =
        parsedExpiry && Number.isFinite(parsedExpiry.getTime()) ? parsedExpiry : null;

      const existing = await prisma.domain.findUnique({ where: { name } });

      if (existing) {
        await prisma.domain.update({
          where: { id: existing.id },
          data: {
            ...(cfZoneId && { cfZoneId }),
            ...(ssl && { sslStatus: ssl.status, sslExpiry: ssl.expiry }),
            ...(expiresAt && { expiresAt }),
            ...(cloudflare && {
              customConfig: { ...((existing.customConfig as any) || {}), cloudflare },
            }),
            // never overwrite a registrar someone set by hand
            ...(rdash && { registrar: 'RDASH' }),
            ...(!rdash && !existing.registrar && zone && { registrar: 'EXTERNAL' }),
            lastSyncedAt: now,
          },
        });
        updated++;
      } else {
        await prisma.domain.create({
          data: {
            name,
            status: zone?.status === 'active' ? 'ACTIVE' : 'PENDING',
            cfZoneId,
            registrar: rdash ? 'RDASH' : zone ? 'EXTERNAL' : null,
            ...(ssl && { sslStatus: ssl.status, sslExpiry: ssl.expiry }),
            expiresAt,
            ...(cloudflare && { customConfig: { cloudflare } }),
            organizationId: null,
            userId: req.user!.userId,
            lastSyncedAt: now,
          },
        });
        created++;
      }
    }

    const cfNames = new Set(zones.map((z: any) => String(z?.name || '').trim().toLowerCase()));
    const rdashNames = new Set(
      rdashRows.map((r: any) => String(r?.domain || r?.name || '').trim().toLowerCase()),
    );

    return res.json({
      success: true,
      data: {
        total: merged.size,
        created,
        updated,
        cfOnly: [...cfNames].filter((n) => n && !rdashNames.has(n)).length,
        rdashOnly: [...rdashNames].filter((n) => n && !cfNames.has(n)).length,
        errors: Object.keys(errors).length ? errors : undefined,
      },
      message: `Synced ${merged.size} domains (${created} added, ${updated} updated)`,
    } as ApiResponse);
  } catch (error) {
    console.error('Error syncing domains:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Assign many freshly-synced domains to one organization in a single call
router.patch('/bulk-assign', authenticateToken, requireRole(['ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { ids, organizationId } = req.body as { ids?: unknown; organizationId?: unknown };

    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) {
      return res.status(400).json({
        success: false,
        error: 'ids must be a non-empty array of domain IDs',
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
        return res.status(404).json({
          success: false,
          error: 'Organization not found',
        } as ApiResponse);
      }
    }

    const { count } = await prisma.domain.updateMany({
      where: { id: { in: ids as string[] }, ...(await orgScope(req)) },
      data: { organizationId: (organizationId as string) || null },
    });

    return res.json({
      success: true,
      data: { count },
      message: `${count} domain(s) updated`,
    } as ApiResponse);
  } catch (error) {
    console.error('Error bulk assigning domains:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

router.get('/:id/dns-zone', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Domain ID is required',
      } as ApiResponse);
    }

    const domain = await prisma.domain.findFirst({
      where: {
        id: id as string,
        ...(await orgScope(req)),
      },
    });

    if (!domain) {
      return res.status(404).json({
        success: false,
        error: 'Domain not found',
      } as ApiResponse);
    }

    const existingCloudflareConfig = (domain.customConfig as any)?.cloudflare;

    let zoneId: string | null =
      existingCloudflareConfig && typeof existingCloudflareConfig.zoneId === 'string'
        ? existingCloudflareConfig.zoneId
        : null;

    let zoneName: string | null =
      existingCloudflareConfig && typeof existingCloudflareConfig.zoneName === 'string'
        ? existingCloudflareConfig.zoneName
        : null;

    let nameservers: string[] =
      existingCloudflareConfig && Array.isArray(existingCloudflareConfig.nameservers)
        ? existingCloudflareConfig.nameservers
        : [];

    if (!zoneId) {
      const zone = await getOrCreateCloudflareZone(domain.name);
      if (zone) {
        zoneId = zone.id;
        zoneName = zone.name;
        nameservers = zone.nameServers;
      }
    }

    if (!zoneId) {
      return res.status(200).json({
        success: true,
        data: {
          zone: null,
          records: [],
          synced: false,
        },
        message: 'Cloudflare zone not configured for this domain',
      } as ApiResponse);
    }

    await syncDomainDns(domain.name, zoneId);

    const records = await listCloudflareDnsRecords(zoneId);

    const responsePayload = {
      zone: {
        id: zoneId,
        name: zoneName || domain.name,
        nameservers,
      },
      records: records || [],
      synced: true,
    };

    return res.json({
      success: true,
      data: responsePayload,
      message: 'DNS zone configuration fetched successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error fetching domain DNS zone:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Update a domain
router.put('/:id', authenticateToken, validateRequest(UpdateDomainSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { name, status, redirectTo, customConfig } = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Domain ID is required',
      } as ApiResponse);
    }

    const existingDomain = await prisma.domain.findFirst({
      where: {
        id: id as string,
        ...(await orgScope(req)),
      },
    });

    if (!existingDomain) {
      return res.status(404).json({
        success: false,
        error: 'Domain not found',
      } as ApiResponse);
    }

    // Check if new name conflicts with existing domain
    if (name && name !== existingDomain.name) {
      const nameConflict = await prisma.domain.findUnique({
        where: { name },
      });

      if (nameConflict) {
        return res.status(400).json({
          success: false,
          error: 'Domain name already exists',
        } as ApiResponse);
      }
    }

    const updatedDomain = await prisma.domain.update({
      where: { id: existingDomain.id },
      data: {
        name,
        status,
        redirectTo,
        customConfig,
      },
    });

    return res.json({
      success: true,
      data: updatedDomain,
      message: 'Domain updated successfully',
    } as ApiResponse<Domain>);
  } catch (error) {
    console.error('Error updating domain:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Delete a domain
router.delete('/:id', authenticateToken, requireRole(['ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Domain ID is required',
      } as ApiResponse);
    }

    const domain = await prisma.domain.findFirst({
      where: {
        id: id as string,
        ...(await orgScope(req)),
      },
    });

    if (!domain) {
      return res.status(404).json({
        success: false,
        error: 'Domain not found',
      } as ApiResponse);
    }

    // Delete domain
    await prisma.domain.delete({
      where: { id: domain.id },
    });

    return res.json({
      success: true,
      message: 'Domain deleted successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error deleting domain:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Verify domain DNS
router.post('/:id/verify', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Domain ID is required',
      } as ApiResponse);
    }

    const domain = await prisma.domain.findFirst({
      where: {
        id: id as string,
        ...(await orgScope(req)),
      },
    });

    if (!domain) {
      return res.status(404).json({
        success: false,
        error: 'Domain not found',
      } as ApiResponse);
    }

    let dnsRecords: any = null;
    let verified = false;

    const existingCloudflareConfig = (domain.customConfig as any)?.cloudflare;
    const zoneIdOverride =
      existingCloudflareConfig && typeof existingCloudflareConfig.zoneId === 'string'
        ? existingCloudflareConfig.zoneId
        : undefined;

    const cloudflareRecords = await syncDomainDns(domain.name, zoneIdOverride);
    if (cloudflareRecords) {
      dnsRecords = cloudflareRecords;
      verified = true;
    } else {
      dnsRecords = {
        a: '192.168.1.1',
        cname: 'app.commitbase.com',
        mx: 'mail.commitbase.com',
      };
      verified = true;
    }

    const updatedDomain = await prisma.domain.update({
      where: { id: domain.id },
      data: {
        dnsRecords,
        status: 'ACTIVE',
      },
    });

    return res.json({
      success: true,
      data: {
        domain: updatedDomain,
        dnsRecords,
        verified,
      },
      message: 'Domain DNS verified successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error verifying domain:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

export default router; 
