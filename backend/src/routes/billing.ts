import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ApiResponse } from '../types';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { canManageOrg, getOrgRole, isPlatformAdmin, listMemberships } from '../lib/scope';
import { currentRate, EMAIL_WATCHER_RATES, priceOf, RATES, usageByDay, WA_RATES, WIB_MS } from '../services/usageMeterService';
import { billingUserOf, daysOf, hostingBillingFrom, negativeLimit, paidWorkspaces, perDayOf, perDayOfUser } from '../services/walletService';
import { ArusniagaError, createTopUp, TOPUP_MAX, TOPUP_MIN, topUpView } from '../services/arusniagaService';
import { getArusniagaConfig } from '../services/integrationConfigService';

const router: Router = Router();

/**
 * The workspace a billing request is about: the active one (the switch); a
 * platform admin may name one. Its owners and admins, and platform admins.
 */
async function orgFor(req: AuthenticatedRequest, res: Response): Promise<string | null> {
  const organizationId =
    isPlatformAdmin(req) && typeof req.query.organizationId === 'string'
      ? req.query.organizationId
      : (await listMemberships(req))[0]?.organizationId;
  if (!organizationId) {
    res.status(400).json({ success: false, error: 'Pick a workspace' } as ApiResponse);
    return null;
  }
  if (!(await canManageOrg(req, organizationId))) {
    res.status(403).json({ success: false, error: 'Only the workspace owners and admins see its costs' } as ApiResponse);
    return null;
  }
  return organizationId;
}

/** ?month=YYYY-MM, this month by default — in WIB — and its bounds. */
function monthOf(req: AuthenticatedRequest) {
  const nowWib = new Date(Date.now() + WIB_MS);
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month ?? '')) ? String(req.query.month) : nowWib.toISOString().slice(0, 7);
  const [year, mon] = month.split('-').map(Number) as [number, number];
  return { month, start: new Date(Date.UTC(year, mon - 1, 1) - WIB_MS), end: new Date(Date.UTC(year, mon, 1) - WIB_MS) };
}

/** The price list: the Pricing page reads it, so it never disagrees with the meter. */
router.get('/rates', authenticateToken, (_req: AuthenticatedRequest, res: Response) => {
  return res.json({ success: true, data: { apps: RATES, wa: WA_RATES, email: EMAIL_WATCHER_RATES } } as ApiResponse);
});

/** A workspace's metered use in one month and what it costs — per day, the month so far, and where it is heading. */
router.get('/usage', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId = await orgFor(req, res);
    if (!organizationId) return;
    const { month, start, end } = monthOf(req);

    const monthDays = Math.round((end.getTime() - start.getTime()) / 86_400_000);
    const running = Date.now() >= start.getTime() && Date.now() < end.getTime();
    const sorted = await usageByDay(organizationId, start, end);
    const total = [...sorted.values()].reduce(
      (acc, d) => ({
        cpuSeconds: acc.cpuSeconds + d.cpuSeconds,
        memGbSeconds: acc.memGbSeconds + d.memGbSeconds,
        storageGbSeconds: acc.storageGbSeconds + d.storageGbSeconds,
        objectGbSeconds: (acc.objectGbSeconds ?? 0) + (d.objectGbSeconds ?? 0),
      }),
      { cpuSeconds: 0, memGbSeconds: 0, storageGbSeconds: 0, objectGbSeconds: 0 },
    );
    const cost = priceOf(total, monthDays);

    // the month so far, then what is held now for the hours left — only while the month runs
    const rate = running ? await currentRate(organizationId, monthDays) : null;
    const projected = rate ? cost.total + rate.perHour * ((end.getTime() - Date.now()) / 3_600_000) : null;

    return res.json({
      success: true,
      data: {
        month,
        rates: RATES,
        usage: {
          cpuCoreHours: total.cpuSeconds / 3600,
          memGbHours: total.memGbSeconds / 3600,
          storageGbDays: total.storageGbSeconds / 86_400,
          objectGbDays: (total.objectGbSeconds ?? 0) / 86_400,
        },
        cost,
        projected,
        /** what it holds now and costs per hour — the estimate's pace */
        rate,
        monthDays,
        days: [...sorted.entries()].map(([date, use]) => ({ date, cost: priceOf(use, monthDays).total })),
      },
    } as ApiResponse);
  } catch (error) {
    console.error('Error reading usage:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/**
 * The wallet that pays this workspace — its payer's, shared by every workspace they pay
 * for: the balance, what they all cost a day now and how long it lasts, the negative
 * limit the apps stop at, whether this workspace's are stopped, and who pays — with the
 * owners it could be.
 */
router.get('/wallet', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId = await orgFor(req, res);
    if (!organizationId) return;
    const [org, owners, payer, workspacePerDay] = await Promise.all([
      prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { suspendedAt: true } }),
      prisma.membership.findMany({ where: { organizationId, role: 'OWNER' }, orderBy: { createdAt: 'asc' }, select: { user: { select: { id: true, name: true, email: true } } } }),
      billingUserOf(organizationId),
      perDayOf(organizationId),
    ]);
    const workspaces = payer ? await paidWorkspaces(payer.id) : [organizationId];
    const [wallet, perDay] = await Promise.all([
      payer ? prisma.wallet.findUnique({ where: { userId: payer.id }, select: { balance: true } }) : null,
      payer ? perDayOfUser(payer.id, workspaces) : workspacePerDay,
    ]);
    const balance = wallet?.balance ?? 0n;
    const limit = negativeLimit(perDay);
    return res.json({
      success: true,
      data: {
        organizationId,
        balance: String(balance),
        /** everything the payer pays for, a day now; this workspace's share */
        perDay: String(perDay),
        workspacePerDay: String(workspacePerDay),
        /** how many workspaces share this balance */
        sharedBy: workspaces.length,
        /** the viewer is the payer: the whole wallet is theirs to see */
        isPayer: payer?.id === req.user!.userId,
        /** days until zero, and until the apps stop; null when nothing is spent */
        daysLeft: balance > 0n ? daysOf(balance, perDay) : 0,
        daysUntilStop: daysOf(balance + limit, perDay),
        limit: String(limit),
        suspendedAt: org.suspendedAt,
        hostingBilledFrom: hostingBillingFrom(),
        billingUser: payer,
        owners: owners.map((o) => o.user),
        canChangeBillingUser: isPlatformAdmin(req) || (await getOrgRole(req, organizationId)) === 'OWNER',
      },
    } as ApiResponse);
  } catch (error) {
    console.error('Error reading the wallet:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/**
 * The wallet's entries in one month (WIB), newest first. The payer (and a platform admin)
 * sees the whole wallet — top-ups, gifts, every workspace's use, each named; anyone else
 * managing this workspace sees what was spent on it.
 */
router.get('/entries', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId = await orgFor(req, res);
    if (!organizationId) return;
    const { month, start, end } = monthOf(req);
    const payer = await billingUserOf(organizationId);
    const whole = !!payer && (payer.id === req.user!.userId || isPlatformAdmin(req));
    const rows = await prisma.walletEntry.findMany({
      where: { ...(whole ? { userId: payer!.id } : { organizationId }), createdAt: { gte: start, lt: end } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, kind: true, amount: true, note: true, createdAt: true, updatedAt: true, organization: { select: { id: true, name: true } } },
    });
    return res.json({ success: true, data: { month, whole, entries: rows.map((e) => ({ ...e, amount: String(e.amount) })) } } as ApiResponse);
  } catch (error) {
    console.error('Error reading wallet entries:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

// ── Top-ups: an invoice in ArusNiaga, credited when it is paid there (arusniagaService) ──

/** The top-ups of the wallet that pays this workspace, newest first, and whether top-ups are open at all. */
router.get('/topups', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId = await orgFor(req, res);
    if (!organizationId) return;
    const payer = await billingUserOf(organizationId);
    const [rows, config] = await Promise.all([
      payer ? prisma.topUp.findMany({ where: { userId: payer.id, invoiceId: { not: null } }, orderBy: { createdAt: 'desc' }, take: 20 }) : [],
      getArusniagaConfig(),
    ]);
    return res.json({ success: true, data: { enabled: !!config, min: TOPUP_MIN, max: TOPUP_MAX, topUps: rows.map(topUpView) } } as ApiResponse);
  } catch (error) {
    console.error('Error listing top-ups:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/** A top-up of `amount` rupiah into the wallet that pays this workspace: its invoice, to pay on ArusNiaga's invoice page. Owners and admins. */
router.post('/topups', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId = await orgFor(req, res);
    if (!organizationId) return;
    const amount = Number(req.body?.amount);
    if (!Number.isInteger(amount) || amount < TOPUP_MIN || amount > TOPUP_MAX) {
      return res.status(400).json({ success: false, error: `Top up between Rp ${TOPUP_MIN.toLocaleString('id-ID')} and Rp ${TOPUP_MAX.toLocaleString('id-ID')}` } as ApiResponse);
    }
    const payer = await billingUserOf(organizationId);
    if (!payer) return res.status(409).json({ success: false, error: 'This workspace has no owner to pay for it' } as ApiResponse);
    const topUp = await createTopUp(payer.id, organizationId, amount, req.user!.userId);
    return res.json({ success: true, data: topUpView(topUp) } as ApiResponse);
  } catch (error) {
    if (error instanceof ArusniagaError) {
      console.error('Top-up invoice failed:', error.message);
      return res.status(502).json({ success: false, error: `The invoice could not be issued: ${error.message}` } as ApiResponse);
    }
    console.error('Error creating a top-up:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

export default router;
