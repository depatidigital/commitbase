import { Router, Response } from 'express';
import { AuthenticatedRequest, authenticateToken } from '../middleware/auth';
import { ApiResponse } from '../types';
import { prisma } from '../lib/prisma';
import { canManageOrg, getOrgRole, isPlatformAdmin, listMemberships, orgScope } from '../lib/scope';
import { gateway, gatewayFailure, gatewayStats } from '../services/larikaGatewayService';
import { getLarikaGatewayBaseUrl } from '../services/integrationConfigService';

// A workspace's WhatsApp numbers on the Larika gateway ("Whatsapp Gateway API"):
// any member sees them; owners and admins add, link, delete and hold the API keys.
const router: Router = Router();
router.use(authenticateToken);

const fail = (res: Response, error: unknown) => {
  const { status, body } = gatewayFailure(error);
  if (status === 500) console.error('WA number request failed:', error);
  return res.status(status).json(body);
};

/** The number, when the caller may see it (manage: may change it too); else null. */
async function numberFor(req: AuthenticatedRequest, id: string | undefined, manage = false) {
  const row = await prisma.waNumber.findFirst({ where: { id: String(id), ...(await orgScope(req)) } });
  if (!row) return null;
  if (manage && !(await canManageOrg(req, row.organizationId))) return null;
  return row;
}

const ipList = (value: unknown): string[] | null => {
  const list = (Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/)).map((ip) => String(ip).trim()).filter(Boolean);
  return list.length > 0 && list.length <= 50 ? list : null;
};

const webhook = (value: unknown): string | null | undefined => {
  if (value === undefined) return undefined;
  const url = String(value ?? '').trim();
  return url || null;
};

router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rows = await prisma.waNumber.findMany({
      where: await orgScope(req),
      include: { organization: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    // live status from the gateway; the list still shows when it is down
    const stats = await gatewayStats().catch((error) => error as Error);
    const live = stats instanceof Error ? null : new Map(stats.numbers.map((n) => [n.id, n]));
    const nodes = stats instanceof Error ? null : new Map(stats.agents.map((a) => [a.id, a]));
    const data = await Promise.all(
      rows.map(async (row) => {
        const n = live?.get(row.instanceId);
        return {
          id: row.id,
          name: row.name,
          organization: row.organization,
          createdAt: row.createdAt,
          canManage: await canManageOrg(req, row.organizationId),
          status: live ? (n?.status ?? 'MISSING') : null,
          phone: n?.phone ?? null,
          error: n?.error ?? null,
          sent24h: n?.sent24h ?? 0,
          nodeName: n?.agentId ? (nodes?.get(n.agentId)?.name ?? null) : null,
          nodeOnline: n?.agentId ? (nodes?.get(n.agentId)?.online ?? false) : false,
          webhookUrl: n?.webhookUrl ?? null,
          ipAllowlist: n?.ipAllowlist ?? [],
        };
      }),
    );
    return res.json({ success: true, data, ...(stats instanceof Error && { error: stats.message }) } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const name = String(req.body?.name ?? '').trim();
    if (!name || name.length > 80) return res.status(400).json({ success: false, error: 'Name the number (up to 80 characters)' } as ApiResponse);
    const ipAllowlist = ipList(req.body?.ipAllowlist);
    if (!ipAllowlist) return res.status(400).json({ success: false, error: 'List 1 to 50 IPs allowed to call the API, or * for any' } as ApiResponse);

    // the workspace: the one asked for, else the active one when there is exactly one
    const memberships = await listMemberships(req);
    const organizationId = String(req.body?.organizationId || (memberships.length === 1 ? memberships[0]!.organizationId : ''));
    if (!organizationId) return res.status(400).json({ success: false, error: 'Pick the workspace this number belongs to' } as ApiResponse);
    if (!isPlatformAdmin(req) && !(await getOrgRole(req, organizationId))) {
      return res.status(404).json({ success: false, error: 'Workspace not found' } as ApiResponse);
    }
    if (!(await canManageOrg(req, organizationId))) {
      return res.status(403).json({ success: false, error: 'Only workspace owners and admins add numbers' } as ApiResponse);
    }
    if (!(await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true } }))) {
      return res.status(404).json({ success: false, error: 'Workspace not found' } as ApiResponse);
    }

    const instance = await gateway<{ id: string }>('/admin/instances', {
      method: 'POST',
      body: { name, ipAllowlist, ...(webhook(req.body?.webhookUrl) && { webhookUrl: webhook(req.body.webhookUrl) }) },
    });
    const row = await prisma.waNumber.create({ data: { instanceId: instance.id, name, organizationId, createdById: req.user!.userId } });
    // its first key, shown once: a number without one is no use to an app
    const key = await gateway<{ apiKey: string }>(`/admin/instances/${instance.id}/keys`, { method: 'POST' }).catch(() => null);
    return res.status(201).json({ success: true, data: { id: row.id, apiKey: key?.apiKey ?? null } } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

/** One number as the gateway has it now: status, QR (raw string, rendered by the page), usage. */
router.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const row = await numberFor(req, req.params.id);
    if (!row) return res.status(404).json({ success: false, error: 'Number not found' } as ApiResponse);
    const canManage = await canManageOrg(req, row.organizationId);
    const n = await gateway(`/v1/instances/${row.instanceId}`);
    return res.json({
      success: true,
      data: {
        id: row.id,
        instanceId: row.instanceId,
        name: row.name,
        canManage,
        status: n.status,
        // the QR links a phone to this number: only for who may link it
        qr: canManage ? n.qr : null,
        phone: n.phone,
        profileName: n.profileName,
        error: n.error,
        webhookUrl: n.webhookUrl,
        ipAllowlist: n.ipAllowlist,
        usage: n.usage,
        // what an app calls: <gatewayUrl>/v1/instances/<instanceId>/… with its key
        gatewayUrl: await getLarikaGatewayBaseUrl(),
      },
    } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

router.patch('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const row = await numberFor(req, req.params.id, true);
    if (!row) return res.status(404).json({ success: false, error: 'Number not found' } as ApiResponse);
    const name = req.body?.name === undefined ? undefined : String(req.body.name).trim();
    if (name !== undefined && (!name || name.length > 80)) return res.status(400).json({ success: false, error: 'Name the number (up to 80 characters)' } as ApiResponse);
    const ipAllowlist = req.body?.ipAllowlist === undefined ? undefined : ipList(req.body.ipAllowlist);
    if (ipAllowlist === null) return res.status(400).json({ success: false, error: 'List 1 to 50 IPs allowed to call the API, or * for any' } as ApiResponse);
    await gateway(`/admin/instances/${row.instanceId}`, {
      method: 'PATCH',
      body: { ...(name && { name }), ...(ipAllowlist && { ipAllowlist }), ...(req.body?.webhookUrl !== undefined && { webhookUrl: webhook(req.body.webhookUrl) }) },
    });
    if (name) await prisma.waNumber.update({ where: { id: row.id }, data: { name } });
    return res.json({ success: true } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

/** relink: log the phone out for a new QR; restart: stop and start it on its node. */
for (const action of ['relink', 'restart'] as const) {
  router.post(`/:id/${action}`, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const row = await numberFor(req, req.params.id, true);
      if (!row) return res.status(404).json({ success: false, error: 'Number not found' } as ApiResponse);
      await gateway(`/v1/instances/${row.instanceId}/${action}`, { method: 'POST' });
      return res.json({ success: true } as ApiResponse);
    } catch (error) {
      return fail(res, error);
    }
  });
}

router.delete('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const row = await numberFor(req, req.params.id, true);
    if (!row) return res.status(404).json({ success: false, error: 'Number not found' } as ApiResponse);
    // logs WhatsApp out on its node and deletes its messages and media; gone already is fine
    await gateway(`/v1/instances/${row.instanceId}?purgeMedia=true`, { method: 'DELETE' }).catch((error) => {
      if (error?.status !== 404) throw error;
    });
    await prisma.waNumber.delete({ where: { id: row.id } });
    return res.json({ success: true } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/:id/keys', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const row = await numberFor(req, req.params.id, true);
    if (!row) return res.status(404).json({ success: false, error: 'Number not found' } as ApiResponse);
    const data = await gateway(`/admin/instances/${row.instanceId}/keys`);
    return res.json({ success: true, data } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

/** A new key; its plaintext is in this answer only. */
router.post('/:id/keys', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const row = await numberFor(req, req.params.id, true);
    if (!row) return res.status(404).json({ success: false, error: 'Number not found' } as ApiResponse);
    const data = await gateway(`/admin/instances/${row.instanceId}/keys`, { method: 'POST' });
    return res.json({ success: true, data } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

router.delete('/:id/keys/:keyId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const row = await numberFor(req, req.params.id, true);
    if (!row) return res.status(404).json({ success: false, error: 'Number not found' } as ApiResponse);
    // the gateway revokes any key by id: only one of this number's
    const keys = await gateway<Array<{ id: string }>>(`/admin/instances/${row.instanceId}/keys`);
    if (!keys.some((key) => key.id === req.params['keyId'])) return res.status(404).json({ success: false, error: 'Key not found' } as ApiResponse);
    await gateway(`/admin/keys/${encodeURIComponent(String(req.params['keyId']))}`, { method: 'DELETE' });
    return res.json({ success: true } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

/** The HMAC secret webhooks are signed with (x-larika-signature); POST makes a new one. */
router.get('/:id/webhook-secret', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const row = await numberFor(req, req.params.id, true);
    if (!row) return res.status(404).json({ success: false, error: 'Number not found' } as ApiResponse);
    const data = await gateway(`/admin/instances/${row.instanceId}/webhook-secret`);
    return res.json({ success: true, data } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/:id/webhook-secret', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const row = await numberFor(req, req.params.id, true);
    if (!row) return res.status(404).json({ success: false, error: 'Number not found' } as ApiResponse);
    const data = await gateway(`/admin/instances/${row.instanceId}/webhook-secret`, { method: 'POST' });
    return res.json({ success: true, data } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

export default router;
