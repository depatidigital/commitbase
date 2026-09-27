import { prisma } from '../lib/prisma';
import { syncAiCap } from './aiGatewayService';
import { daysInMonthOf, priceOf, usageByDay, WIB_MS, wibDayStart } from './usageMeterService';

/**
 * A workspace's rupiah wallet: one balance, charged by what it uses — AI calls,
 * its hosting — and filled by top-ups. Paid by its billing user, an OWNER.
 */

export const MICRO = 1_000_000n;
/** What a new user starts with, once: enough to deploy and try things before paying. */
export const WELCOME_CREDIT = 50_000n * MICRO;

/**
 * Money in or out: one entry, and the balance moved in the same transaction.
 * Once per ref — a repeated ref (a payment webhook sent twice) changes nothing and returns false.
 */
export async function addWalletEntry(entry: { organizationId: string; kind: 'TOPUP' | 'ADJUST' | 'WELCOME'; amount: bigint; ref: string; note?: string; createdById?: string }) {
  try {
    await prisma.$transaction([
      prisma.walletEntry.create({ data: entry }),
      prisma.wallet.upsert({
        where: { organizationId: entry.organizationId },
        create: { organizationId: entry.organizationId, balance: entry.amount },
        update: { balance: { increment: entry.amount } },
      }),
    ]);
  } catch (error: any) {
    if (error?.code === 'P2002') return false;
    throw error;
  }
  await syncAiCap(entry.organizationId).catch((error) => console.error('AI spend cap sync failed:', error));
  return true;
}

/** The welcome credit, into this workspace — unless the user had theirs already. */
export const grantWelcomeCredit = (organizationId: string, userId: string) =>
  addWalletEntry({ organizationId, kind: 'WELCOME', amount: WELCOME_CREDIT, ref: `welcome:${userId}`, note: 'Welcome credit' });

/** Who pays a workspace: its billing user while still an OWNER, else its longest-standing OWNER. */
export async function billingUserOf(organizationId: string) {
  const [org, owners] = await Promise.all([
    prisma.organization.findUnique({ where: { id: organizationId }, select: { billingUserId: true } }),
    prisma.membership.findMany({
      where: { organizationId, role: 'OWNER' },
      orderBy: { createdAt: 'asc' },
      select: { user: { select: { id: true, email: true, name: true } } },
    }),
  ]);
  return (owners.find((o) => o.user.id === org?.billingUserId) ?? owners[0])?.user ?? null;
}

// ── Hosting ──

/**
 * The first WIB day (YYYY-MM-DD) hosting is charged — env HOSTING_BILLING_FROM.
 * Unset: not charged yet, the Usage page only shows it.
 */
export const hostingBillingFrom = () => (/^\d{4}-\d{2}-\d{2}$/.test(process.env.HOSTING_BILLING_FROM ?? '') ? process.env.HOSTING_BILLING_FROM! : null);

/** Days a late reading can still change: the meter collects what a node wrote while the panel was down. */
const RECHARGE_DAYS = 2;
const DAY_MS = 86_400_000;
const HOSTING_LOCK = 7_431_002;

/**
 * Charge each workspace its hosting, one entry per WIB day (`host:<org>:<day>`),
 * set to what the day cost so far — today and the last days rewritten as
 * readings arrive, the balance moved by the difference. From the cutover on.
 */
export async function billHosting(): Promise<string> {
  const from = hostingBillingFrom();
  if (!from) return 'skipped — HOSTING_BILLING_FROM is not set';
  const cutover = Date.parse(`${from}T00:00:00Z`) - WIB_MS;
  const start = new Date(Math.max(cutover, wibDayStart(Date.now()) - RECHARGE_DAYS * DAY_MS));
  const end = new Date(wibDayStart(Date.now()) + DAY_MS);

  // every workspace that has anything to pay for: services, or use in the window
  const orgs = await prisma.organization.findMany({
    where: { OR: [{ applications: { some: {} } }, { usage: { some: { hour: { gte: start } } } }] },
    select: { id: true },
  });
  let moved = 0;
  for (const { id: organizationId } of orgs) {
    const days = await usageByDay(organizationId, start, end);
    const charges = [...days].map(([day, use]) => ({
      ref: `host:${organizationId}:${day}`,
      note: `Hosting · ${day}`,
      amount: BigInt(Math.round(priceOf(use, daysInMonthOf(day)).total * 1e6)),
    }));
    if (!charges.some((c) => c.amount > 0n)) continue;

    const delta = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${HOSTING_LOCK})`;
      let delta = 0n;
      for (const c of charges) {
        const had = await tx.walletEntry.findUnique({ where: { ref: c.ref }, select: { amount: true } });
        // mostly more as the day goes on; less when a reading replaced today's estimate
        const change = -c.amount - (had?.amount ?? 0n);
        if (change === 0n) continue;
        await tx.walletEntry.upsert({
          where: { ref: c.ref },
          create: { ref: c.ref, organizationId, kind: 'HOSTING_USAGE', amount: -c.amount, note: c.note },
          update: { amount: -c.amount },
        });
        delta += change;
      }
      if (delta) {
        await tx.wallet.upsert({
          where: { organizationId },
          create: { organizationId, balance: delta },
          update: { balance: { increment: delta } },
        });
      }
      return delta;
    });
    if (delta) {
      moved++;
      // what hosting took, AI can no longer spend
      await syncAiCap(organizationId).catch((error) => console.error(`AI spend cap sync failed (${organizationId}):`, error));
    }
  }
  return `hosting charged to ${moved} of ${orgs.length} workspace(s)`;
}
