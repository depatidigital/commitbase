import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ApiResponse } from '../types';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { canManageOrg, isPlatformAdmin, listMemberships } from '../lib/scope';
import { backfillStorageDays, currentRate, heldBetween, priceOf, RATES, WIB_MS, wibDayStart, type Use } from '../services/usageMeterService';

const router: Router = Router();

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

    const days = new Map<string, Use>();
    // storage by the day, at what was held that day — read, or backfilled for days before metering began
    await backfillStorageDays(organizationId);
    const stored = await prisma.storageDay.findMany({ where: { organizationId, day: { gte: start, lt: end } } });
    const GiB = 1024 ** 3;
    const bill = (day: number, held: { diskBytes: number; journalBytes: number; objectBytes: number }) => {
      // today: so far
      const seconds = (Math.min(day + 86_400_000, now) - day) / 1000;
      days.set(dayKey(day), {
        cpuSeconds: 0,
        memGbSeconds: 0,
        storageGbSeconds: ((held.diskBytes + held.journalBytes) / GiB) * seconds,
        objectGbSeconds: (held.objectBytes / GiB) * seconds,
      });
    };
    for (const row of stored) {
      bill(row.day.getTime(), { diskBytes: Number(row.diskBytes), journalBytes: Number(row.journalBytes), objectBytes: Number(row.objectBytes) });
    }
    // today before the meter's first reading of it: the sizes known now
    const today = wibDayStart(now);
    if (running && !days.has(dayKey(today))) {
      const [apps, org, journal] = await Promise.all([
        prisma.application.findMany({ where: { organizationId }, select: { diskBytes: true, createdAt: true, type: true, staticBucket: true } }),
        prisma.organization.findUnique({ where: { id: organizationId }, select: { createdAt: true } }),
        prisma.orgNode.aggregate({ where: { organizationId }, _sum: { meterJournalBytes: true } }),
      ]);
      const held = heldBetween(apps, { bytes: Number(journal._sum.meterJournalBytes ?? 0), since: org?.createdAt ?? new Date(today) }, today, now);
      if (apps.length) bill(today, held);
    }
    for (const row of hours) {
      const day = dayKey(row.hour.getTime());
      const sum = days.get(day) ?? { cpuSeconds: 0, memGbSeconds: 0, storageGbSeconds: 0, objectGbSeconds: 0 };
      days.set(day, { ...sum, cpuSeconds: sum.cpuSeconds + row.cpuSeconds, memGbSeconds: sum.memGbSeconds + row.memGbSeconds });
    }
    // in date order, for the chart
    const sorted = new Map([...days.entries()].sort(([a], [b]) => a.localeCompare(b)));
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

export default router;
