import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ApiResponse } from '../types';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { canManageOrg, getOrgRole, isPlatformAdmin, listMemberships } from '../lib/scope';
import { currentRate, priceOf, RATES, usageByDay, WA_RATES, WIB_MS } from '../services/usageMeterService';
import { billingUserOf, daysOf, hostingBillingFrom, negativeLimit, perDayOf } from '../services/walletService';

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
  return res.json({ success: true, data: { apps: RATES, wa: WA_RATES } } as ApiResponse);
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
 * The workspace's wallet: its balance, what it costs a day now and how long the
 * balance lasts, the negative limit its apps stop at, whether they are stopped,
 * and who pays — with the owners it could be.
 */
router.get('/wallet', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId = await orgFor(req, res);
    if (!organizationId) return;
    const [org, owners, payer, perDay] = await Promise.all([
      prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { suspendedAt: true, wallet: { select: { balance: true } } } }),
      prisma.membership.findMany({ where: { organizationId, role: 'OWNER' }, orderBy: { createdAt: 'asc' }, select: { user: { select: { id: true, name: true, email: true } } } }),
      billingUserOf(organizationId),
      perDayOf(organizationId),
    ]);
    const balance = org.wallet?.balance ?? 0n;
    const limit = negativeLimit(perDay);
    return res.json({
      success: true,
      data: {
        organizationId,
        balance: String(balance),
        perDay: String(perDay),
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

/** The wallet's entries in one month (WIB): top-ups, welcome credit, hosting and AI by the day. Newest first. */
router.get('/entries', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId = await orgFor(req, res);
    if (!organizationId) return;
    const { month, start, end } = monthOf(req);
    const rows = await prisma.walletEntry.findMany({
      where: { organizationId, createdAt: { gte: start, lt: end } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, kind: true, amount: true, note: true, createdAt: true, updatedAt: true },
    });
    return res.json({ success: true, data: { month, entries: rows.map((e) => ({ ...e, amount: String(e.amount) })) } } as ApiResponse);
  } catch (error) {
    console.error('Error reading wallet entries:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

export default router;
