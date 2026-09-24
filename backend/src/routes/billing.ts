import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ApiResponse } from '../types';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { canManageOrg, isPlatformAdmin, listMemberships } from '../lib/scope';
import { currentRate, priceOf, RATES } from '../services/usageMeterService';

const router = Router();

/** Days are Jakarta's (WIB, UTC+7): what a customer calls "today". */
const WIB_MS = 7 * 3_600_000;

/**
 * A workspace's metered use in one month and what it costs — pay for what you
 * use. Per day, the month so far, and where the month is heading. The active
 * workspace (the switch); a platform admin may name one. Its owners and admins
 * see it, and platform admins.
 */
router.get('/usage', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const organizationId =
      isPlatformAdmin(req) && typeof req.query.organizationId === 'string'
        ? req.query.organizationId
        : (await listMemberships(req))[0]?.organizationId;
    if (!organizationId) return res.status(400).json({ success: false, error: 'Pick a workspace' } as ApiResponse);
    if (!(await canManageOrg(req, organizationId))) {
      return res.status(403).json({ success: false, error: 'Only the workspace owners and admins see its costs' } as ApiResponse);
    }

    // YYYY-MM, this month by default — in WIB
    const nowWib = new Date(Date.now() + WIB_MS);
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month ?? '')) ? String(req.query.month) : nowWib.toISOString().slice(0, 7);
    const [year, mon] = month.split('-').map(Number) as [number, number];
    const start = new Date(Date.UTC(year, mon - 1, 1) - WIB_MS);
    const end = new Date(Date.UTC(year, mon, 1) - WIB_MS);

    const hours = await prisma.usageHour.findMany({
      where: { organizationId, hour: { gte: start, lt: end } },
      orderBy: { hour: 'asc' },
    });
    const monthDays = Math.round((end.getTime() - start.getTime()) / 86_400_000);
    const now = Date.now();
    const running = now >= start.getTime() && now < end.getTime();
    const dayKey = (at: number) => new Date(at + WIB_MS).toISOString().slice(0, 10);

    const days = new Map<string, { cpuSeconds: number; memGbSeconds: number; storageGbSeconds: number }>();
    // This month's storage is charged by the day from the 1st — or from when a service was made —
    // on what each holds now, not only since the meter began; the meter's storage is left out
    // then, or it would count twice. A past month keeps what the meter recorded.
    const apps = running
      ? await prisma.application.findMany({ where: { organizationId }, select: { diskBytes: true, createdAt: true } })
      : [];
    const heldGb = (from: number, to: number) =>
      apps.reduce((sum, app) => {
        const since = Math.max(from, app.createdAt.getTime());
        return sum + (to > since ? (Number(app.diskBytes ?? 0) / 1024 ** 3) * ((to - since) / 1000) : 0);
      }, 0);
    if (running) {
      for (let day = start.getTime(); day < now; day += 86_400_000) {
        days.set(dayKey(day), { cpuSeconds: 0, memGbSeconds: 0, storageGbSeconds: heldGb(day, Math.min(day + 86_400_000, now)) });
      }
    }
    for (const row of hours) {
      const day = new Date(row.hour.getTime() + WIB_MS).toISOString().slice(0, 10);
      const sum = days.get(day) ?? { cpuSeconds: 0, memGbSeconds: 0, storageGbSeconds: 0 };
      days.set(day, {
        cpuSeconds: sum.cpuSeconds + row.cpuSeconds,
        memGbSeconds: sum.memGbSeconds + row.memGbSeconds,
        storageGbSeconds: sum.storageGbSeconds + (running ? 0 : row.storageGbSeconds),
      });
    }
    const total = [...days.values()].reduce(
      (acc, d) => ({
        cpuSeconds: acc.cpuSeconds + d.cpuSeconds,
        memGbSeconds: acc.memGbSeconds + d.memGbSeconds,
        storageGbSeconds: acc.storageGbSeconds + d.storageGbSeconds,
      }),
      { cpuSeconds: 0, memGbSeconds: 0, storageGbSeconds: 0 },
    );
    const cost = priceOf(total, monthDays);

    // the month so far, then what is held now for the hours left — only while the month runs
    const rate = running ? await currentRate(organizationId, monthDays) : null;
    const projected = rate ? cost.total + rate.perHour * ((end.getTime() - now) / 3_600_000) : null;

    return res.json({
      success: true,
      data: {
        month,
        rates: RATES,
        usage: {
          cpuCoreHours: total.cpuSeconds / 3600,
          memGbHours: total.memGbSeconds / 3600,
          storageGbDays: total.storageGbSeconds / 86_400,
        },
        cost,
        projected,
        /** what it holds now and costs per hour — the estimate's pace */
        rate,
        monthDays,
        days: [...days.entries()].map(([date, use]) => ({ date, cost: priceOf(use, monthDays).total })),
      },
    } as ApiResponse);
  } catch (error) {
    console.error('Error reading usage:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

export default router;
