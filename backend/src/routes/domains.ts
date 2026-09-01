import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { CreateDomainSchema, UpdateDomainSchema, ApiResponse, Domain } from '../types';
import { validateRequest } from '../middleware/validation';
import { authenticateToken, requireRole, AuthenticatedRequest } from '../middleware/auth';
import { orgScope } from '../lib/scope';
import { paging, paginated, contains } from '../lib/paging';
import { syncDomainDns, getOrCreateCloudflareZone, listCloudflareDnsRecords, listCloudflareZones, getZoneSslState, importDnsRecords, createDnsRecord, updateDnsRecord, deleteDnsRecord, getDefaultDnsTarget } from '../services/cloudflareService';
import { listRdashDomains, findRdashDomain, getRdashDomainDns, updateRdashDomainNameservers, renewRdashDomain } from '../services/rdashService';
import { startDomainSync, getDomainSyncState } from '../services/domainSyncService';
import { getDomainRegistration } from '../services/rdapService';

/** `?sort=&order=` — whitelisted so the query cannot be steered from the URL. */
const sortOrder = (sort: unknown, order: unknown): any => {
  const direction = order === 'desc' ? 'desc' : 'asc';

  switch (sort) {
    case 'name':
      return { name: direction };
    case 'status':
      return { status: direction };
    // undated domains sort last either way — they are not "expiring soonest"
    case 'expiresAt':
      return { expiresAt: { sort: direction, nulls: 'last' } };
    case 'sslExpiry':
      return { sslExpiry: { sort: direction, nulls: 'last' } };
    case 'createdAt':
      return { createdAt: direction };
    default:
      return { createdAt: 'desc' };
  }
};

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
      // ?filter=unassigned — drives the tabs on the domains page.
      // AND, not a bare key, so it narrows orgScope instead of replacing it.
      AND: [
        ...(req.query.filter === 'unassigned' ? [{ organizationId: null }] : []),
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
        orderBy: sortOrder(req.query.sort, req.query.order),
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

// What "this platform" resolves to — the list uses it to badge domains pointing at us.
// Must sit before GET /:id or express matches "platform-target" as a domain id
router.get('/platform-target', authenticateToken, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json({ success: true, data: await getDefaultDnsTarget() } as ApiResponse);
  } catch (error) {
    console.error('Error fetching platform DNS target:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

// Status of the running/last sync — must sit before GET /:id or express
// matches "sync" as a domain id
router.get('/sync/status', authenticateToken, requireRole(['ADMIN']), async (_req: AuthenticatedRequest, res: Response) => {
  return res.json({ success: true, data: getDomainSyncState() } as ApiResponse);
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
  const state = startDomainSync(req.user!.userId);

  // 202: the run takes minutes, so the client polls GET /domains/sync/status
  return res.status(202).json({
    success: true,
    data: state,
    message: 'Domain sync started',
  } as ApiResponse);
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
      // so the UI can show "this platform" instead of a bare IP for records pointing at us
      platformTarget: await getDefaultDnsTarget(),
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

/** RDASH sends records in a few shapes — normalise to what Cloudflare's API wants. */
const toImportableRecords = (rows: any[], domainName: string) =>
  rows
    .map((row) => {
      const type = String(row?.type || row?.record_type || '').trim().toUpperCase();
      const rawName = String(row?.name || row?.host || row?.hostname || '').trim();
      const content = String(row?.content ?? row?.value ?? row?.data ?? '').trim();

      if (!type || !content) return null;

      // "@", "" and bare subdomains all need to be fully qualified for Cloudflare
      const name =
        !rawName || rawName === '@'
          ? domainName
          : rawName.endsWith(domainName)
          ? rawName
          : `${rawName}.${domainName}`;

      const ttl = Number(row?.ttl);
      const priority = Number(row?.priority ?? row?.prio ?? row?.mx_priority);

      return {
        type,
        name,
        content,
        ...(Number.isFinite(ttl) && ttl > 0 && { ttl }),
        ...(Number.isFinite(priority) && { priority }),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

// What RDASH still holds for this domain: its nameservers and, while it is authoritative, its DNS records
router.get('/:id/rdash-dns', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    const domain = await prisma.domain.findFirst({
      where: { id: id as string, ...(await orgScope(req)) },
    });

    if (!domain) {
      return res.status(404).json({ success: false, error: 'Domain not found' } as ApiResponse);
    }

    if (domain.registrar !== 'RDASH') {
      return res.json({
        success: true,
        data: { registered: false, nameservers: [], records: [] },
        message: 'Domain is not registered through a managed registrar',
      } as ApiResponse);
    }

    const rdashDomain = await findRdashDomain(domain.name);

    if (!rdashDomain) {
      return res.json({
        success: true,
        data: { registered: false, nameservers: [], records: [] },
        message: 'Domain not found at the registrar',
      } as ApiResponse);
    }

    const records = await getRdashDomainDns(rdashDomain.id);

    return res.json({
      success: true,
      data: {
        registered: true,
        nameservers: rdashDomain.nameservers,
        // nameservers already on Cloudflare mean RDASH's own zone is no longer authoritative
        delegatedToCloudflare: rdashDomain.nameservers.some((ns) =>
          ns.toLowerCase().includes('ns.cloudflare.com'),
        ),
        records,
      },
      message: 'Registrar DNS retrieved successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Error fetching RDASH DNS:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to read DNS from the registrar',
    } as ApiResponse);
  }
});

/**
 * Turn Cloudflare on for a domain. Order matters: snapshot the registrar's records
 * FIRST, copy them into the new zone, and only then repoint the nameservers —
 * otherwise the domain resolves from an empty zone during the cutover.
 */
router.post('/:id/cloudflare/enable', authenticateToken, requireRole(['ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    const domain = await prisma.domain.findFirst({
      where: { id: id as string, ...(await orgScope(req)) },
    });

    if (!domain) {
      return res.status(404).json({ success: false, error: 'Domain not found' } as ApiResponse);
    }

    const steps: string[] = [];
    const warnings: string[] = [];

    // 1. snapshot whatever the registrar serves today
    let snapshot: any[] = [];
    let rdashDomain = null;

    if (domain.registrar === 'RDASH') {
      rdashDomain = await findRdashDomain(domain.name);
      if (rdashDomain) {
        try {
          snapshot = await getRdashDomainDns(rdashDomain.id);
          steps.push(`Recorded ${snapshot.length} DNS record(s) from RDASH`);
        } catch {
          warnings.push('Could not read the existing DNS records from the registrar');
        }
      } else {
        warnings.push('Domain is marked as registrar-managed but was not found at the registrar');
      }
    }

    // 2. zone first, so there is somewhere to put them
    let zone;
    try {
      zone = await getOrCreateCloudflareZone(domain.name);
    } catch (error: any) {
      return res.status(502).json({
        success: false,
        error: `Cloudflare could not create the zone: ${error?.message || 'unknown error'}`,
      } as ApiResponse);
    }

    if (!zone) {
      return res.status(502).json({
        success: false,
        error: 'Could not create the Cloudflare zone. Check the Cloudflare integration config.',
      } as ApiResponse);
    }
    steps.push(`Cloudflare zone ready (${zone.id})`);

    // 3. copy the records across
    let importResult = { imported: 0, skipped: 0, failed: [] as string[] };
    if (snapshot.length > 0) {
      importResult = await importDnsRecords(zone.id, toImportableRecords(snapshot, domain.name));
      steps.push(
        `Copied ${importResult.imported} record(s) into Cloudflare (${importResult.skipped} already present)`,
      );
      if (importResult.failed.length > 0) {
        warnings.push(`Cloudflare rejected: ${importResult.failed.join(', ')}`);
      }
    }

    // 4. only now hand DNS over
    let nameserversUpdated = false;
    if (rdashDomain && zone.nameServers.length > 0) {
      try {
        await updateRdashDomainNameservers(domain.name, { nameservers: zone.nameServers });
        nameserversUpdated = true;
        steps.push(`Pointed the RDASH nameservers at ${zone.nameServers.join(', ')}`);
      } catch (error: any) {
        warnings.push(
          `Could not update the nameservers at the registrar: ${error?.message || 'unknown error'}`,
        );
      }
    } else if (!rdashDomain) {
      warnings.push(
        `Set these nameservers at your registrar manually: ${zone.nameServers.join(', ')}`,
      );
    }

    const ssl = await getZoneSslState(zone.id);

    const updated = await prisma.domain.update({
      where: { id: domain.id },
      data: {
        cfZoneId: zone.id,
        status: 'ACTIVE',
        ...(ssl && { sslStatus: ssl.status, sslExpiry: ssl.expiry }),
        customConfig: {
          ...((domain.customConfig as any) || {}),
          cloudflare: {
            zoneId: zone.id,
            zoneName: zone.name,
            nameservers: zone.nameServers,
            synced: true,
          },
          // kept so the pre-cutover DNS is recoverable if the migration goes wrong
          ...(snapshot.length > 0 && {
            rdashDnsSnapshot: { takenAt: new Date().toISOString(), records: snapshot },
          }),
        },
      },
    });

    return res.json({
      success: true,
      data: {
        domain: updated,
        zone,
        steps,
        warnings,
        nameserversUpdated,
        recordsImported: importResult.imported,
      },
      message: 'Cloudflare enabled for this domain',
    } as ApiResponse);
  } catch (error) {
    console.error('Error enabling Cloudflare for domain:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

/**
 * Detach the domain from Cloudflare in our records. The zone itself is left alone —
 * deleting it while the nameservers still point there would take the domain offline.
 */
router.post('/:id/cloudflare/disable', authenticateToken, requireRole(['ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    const domain = await prisma.domain.findFirst({
      where: { id: id as string, ...(await orgScope(req)) },
    });

    if (!domain) {
      return res.status(404).json({ success: false, error: 'Domain not found' } as ApiResponse);
    }

    const { cloudflare, ...restConfig } = ((domain.customConfig as any) || {}) as Record<string, any>;

    const updated = await prisma.domain.update({
      where: { id: domain.id },
      data: {
        cfZoneId: null,
        status: 'PENDING',
        sslStatus: 'PENDING',
        sslExpiry: null,
        customConfig: restConfig,
      },
    });

    return res.json({
      success: true,
      data: updated,
      message:
        'Cloudflare detached in CommitBase. The zone still exists in Cloudflare — repoint the nameservers at your registrar before deleting it.',
    } as ApiResponse);
  } catch (error) {
    console.error('Error disabling Cloudflare for domain:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Registration record straight from the registry (RDAP) — who it is registered
// with, when it was created, and what the registry-side status is.
router.get('/:id/registration', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    const domain = await prisma.domain.findFirst({
      where: { id: id as string, ...(await orgScope(req)) },
    });

    if (!domain) {
      return res.status(404).json({ success: false, error: 'Domain not found' } as ApiResponse);
    }

    const registration = await getDomainRegistration(domain.name);

    return res.json({
      success: true,
      data: registration,
      message: registration
        ? 'Registration retrieved successfully'
        : 'No registry record available for this domain',
    } as ApiResponse);
  } catch (error) {
    console.error('Error fetching domain registration:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

// Renew a domain registration at the registrar (RDASH only) — spends reseller balance
router.post('/:id/renew', authenticateToken, requireRole(['ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const years = Math.min(Math.max(Number(req.body?.years) || 1, 1), 10);

    const domain = await prisma.domain.findFirst({
      where: { id: id as string, ...(await orgScope(req)) },
    });

    if (!domain) {
      return res.status(404).json({ success: false, error: 'Domain not found' } as ApiResponse);
    }

    if (domain.registrar !== 'RDASH') {
      return res.status(400).json({
        success: false,
        error: 'This domain is not managed by a connected registrar. Renew it where it is registered.',
      } as ApiResponse);
    }

    await renewRdashDomain(domain.name, years);

    return res.json({
      success: true,
      data: domain,
      message: `Renewal for ${years} year(s) submitted to the registrar. Run Sync domains to refresh the expiry date.`,
    } as ApiResponse);
  } catch (error) {
    console.error('Error renewing domain:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    } as ApiResponse);
  }
});

const DNS_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA'];

/** The zone a domain's records live in, or null when it is not on Cloudflare yet. */
const zoneIdOf = (domain: { cfZoneId: string | null; customConfig: any }) =>
  domain.cfZoneId || ((domain.customConfig as any)?.cloudflare?.zoneId as string | undefined) || null;

/**
 * Records are written straight to Cloudflare, so validate here: the name has to stay
 * inside this domain, otherwise one tenant could point a record at another's hostname.
 */
const parseRecordBody = async (body: any, domainName: string) => {
  // "Auto" means: point at whatever the platform serves, and let the target decide A vs CNAME
  if (body?.auto === true) {
    const target = await getDefaultDnsTarget();
    if (!target) {
      return { error: 'No platform DNS target is configured — pick a custom record type' };
    }
    body = { ...body, type: target.type, content: target.content, proxied: true };
  }

  const type = String(body?.type || '').trim().toUpperCase();
  const content = String(body?.content || '').trim();
  const rawName = String(body?.name || '').trim().toLowerCase().replace(/\.$/, '');

  if (!DNS_RECORD_TYPES.includes(type)) {
    return { error: `Type must be one of ${DNS_RECORD_TYPES.join(', ')}` };
  }
  if (!content) {
    return { error: 'Content is required' };
  }

  // accept "app", "app.example.com" and "@" — all resolve to a name inside the zone
  const name =
    !rawName || rawName === '@' || rawName === domainName
      ? domainName
      : rawName.endsWith(`.${domainName}`)
      ? rawName
      : `${rawName}.${domainName}`;

  if (name !== domainName && !name.endsWith(`.${domainName}`)) {
    return { error: `Name must be inside ${domainName}` };
  }

  const ttl = Number(body?.ttl);
  const priority = Number(body?.priority);

  return {
    record: {
      type,
      name,
      content,
      ...(Number.isFinite(ttl) && ttl > 0 && { ttl }),
      ...(type === 'MX' && Number.isFinite(priority) && { priority }),
      ...(typeof body?.proxied === 'boolean' && { proxied: body.proxied }),
    },
  };
};

const loadDomainForDns = async (req: AuthenticatedRequest) => {
  const domain = await prisma.domain.findFirst({
    where: { id: req.params.id as string, ...(await orgScope(req)) },
  });

  if (!domain) return { error: { status: 404, message: 'Domain not found' } };

  const zoneId = zoneIdOf(domain);
  if (!zoneId) {
    return { error: { status: 400, message: 'This domain has no Cloudflare zone yet' } };
  }

  return { domain, zoneId };
};

// Create a DNS record (a subdomain, in practice) in the domain's Cloudflare zone
router.post('/:id/dns-records', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const loaded = await loadDomainForDns(req);
    if (loaded.error) {
      return res
        .status(loaded.error.status)
        .json({ success: false, error: loaded.error.message } as ApiResponse);
    }

    const parsed = await parseRecordBody(req.body, loaded.domain!.name);
    if (parsed.error) {
      return res.status(400).json({ success: false, error: parsed.error } as ApiResponse);
    }

    const record = await createDnsRecord(loaded.zoneId!, parsed.record!);

    return res.status(201).json({
      success: true,
      data: record,
      message: 'DNS record created',
    } as ApiResponse);
  } catch (error: any) {
    console.error('Error creating DNS record:', error);
    return res.status(502).json({
      success: false,
      error: error?.message || 'Failed to create the DNS record',
    } as ApiResponse);
  }
});

router.put('/:id/dns-records/:recordId', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const loaded = await loadDomainForDns(req);
    if (loaded.error) {
      return res
        .status(loaded.error.status)
        .json({ success: false, error: loaded.error.message } as ApiResponse);
    }

    const parsed = await parseRecordBody(req.body, loaded.domain!.name);
    if (parsed.error) {
      return res.status(400).json({ success: false, error: parsed.error } as ApiResponse);
    }

    const record = await updateDnsRecord(
      loaded.zoneId!,
      req.params.recordId as string,
      parsed.record!,
    );

    return res.json({
      success: true,
      data: record,
      message: 'DNS record updated',
    } as ApiResponse);
  } catch (error: any) {
    console.error('Error updating DNS record:', error);
    return res.status(502).json({
      success: false,
      error: error?.message || 'Failed to update the DNS record',
    } as ApiResponse);
  }
});

router.delete('/:id/dns-records/:recordId', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const loaded = await loadDomainForDns(req);
    if (loaded.error) {
      return res
        .status(loaded.error.status)
        .json({ success: false, error: loaded.error.message } as ApiResponse);
    }

    await deleteDnsRecord(loaded.zoneId!, req.params.recordId as string);

    return res.json({ success: true, message: 'DNS record deleted' } as ApiResponse);
  } catch (error: any) {
    console.error('Error deleting DNS record:', error);
    return res.status(502).json({
      success: false,
      error: error?.message || 'Failed to delete the DNS record',
    } as ApiResponse);
  }
});

/**
 * Copy the DNS the registrar holds into the Cloudflare zone. Uses the snapshot taken at
 * cutover when there is one, otherwise reads RDASH live — after a migration the registrar's
 * own zone is usually already empty, so the snapshot is the useful source.
 */
router.post('/:id/dns-records/import', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const loaded = await loadDomainForDns(req);
    if (loaded.error) {
      return res
        .status(loaded.error.status)
        .json({ success: false, error: loaded.error.message } as ApiResponse);
    }

    const domain = loaded.domain!;
    const snapshot = (domain.customConfig as any)?.rdashDnsSnapshot?.records;
    let records: any[] = Array.isArray(snapshot) ? snapshot : [];
    let source = 'the snapshot taken when this domain moved to Cloudflare';

    if (records.length === 0 && domain.registrar === 'RDASH') {
      const rdashDomain = await findRdashDomain(domain.name);
      if (rdashDomain) {
        records = await getRdashDomainDns(rdashDomain.id);
        source = 'RDASH';
      }
    }

    // an empty registrar zone is the normal case for a parked or already-migrated
    // domain — that is an answer, not a failure
    if (records.length === 0) {
      return res.json({
        success: true,
        data: {
          imported: 0,
          skipped: 0,
          failed: [],
          note:
            domain.registrar === 'RDASH'
              ? 'RDASH holds no DNS records for this domain, so there is nothing to copy.'
              : 'No saved registrar records for this domain — add subdomains manually.',
        },
        message: 'Nothing to import',
      } as ApiResponse);
    }

    const result = await importDnsRecords(
      loaded.zoneId!,
      toImportableRecords(records, domain.name),
    );

    return res.json({
      success: true,
      data: result,
      message: `Imported ${result.imported} record(s) from ${source} (${result.skipped} already present)`,
    } as ApiResponse);
  } catch (error: any) {
    console.error('Error importing DNS records:', error);
    return res.status(502).json({
      success: false,
      error: error?.message || 'Failed to import the DNS records',
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

// Point the domain's DNS at us, through Cloudflare. Reports what actually happened —
// a domain with no zone, or a Cloudflare call that fails, is not "verified".
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

    const zoneId =
      domain.cfZoneId || ((domain.customConfig as any)?.cloudflare?.zoneId as string | undefined);

    if (!zoneId) {
      return res.status(400).json({
        success: false,
        error: 'No Cloudflare zone for this domain — create the zone before verifying DNS.',
      } as ApiResponse);
    }

    const dnsRecords = await syncDomainDns(domain.name, zoneId);

    if (!dnsRecords) {
      return res.status(502).json({
        success: false,
        error:
          'Cloudflare did not accept the DNS record. Check the zone and the configured DNS target.',
      } as ApiResponse);
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
        verified: true,
      },
      message: 'DNS record confirmed in Cloudflare',
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
