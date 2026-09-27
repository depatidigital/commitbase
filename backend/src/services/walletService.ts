import { prisma } from '../lib/prisma';
import { sendMail } from '../lib/mailer';
import { syncAiCap } from './aiGatewayService';
import { DeploymentService } from './deployment';
import { currentRate, daysInMonthOf, priceOf, usageByDay, WIB_MS, wibDayStart } from './usageMeterService';

/**
 * A user's rupiah wallet: one balance, shared by every workspace they pay for (its
 * billing user, an OWNER) — charged by what those use (AI calls, hosting, domains) and
 * filled by top-ups, gifts and the welcome credit. Entries name the workspace they were
 * spent on, so the statement still says which one cost what.
 */

export const MICRO = 1_000_000n;
/** What a new user starts with, once: enough to deploy and try things before paying. */
export const WELCOME_CREDIT = 50_000n * MICRO;
/** A gift from a platform admin: rupiah, whole — the ceiling keeps a typo from giving away millions. */
export const GIFT_MIN = 1_000;
export const GIFT_MAX = 10_000_000;

/**
 * Money in or out of a user's wallet: one entry, and the balance moved in the same
 * transaction. organizationId: the workspace it was spent on (a refund of it), none for
 * money in. Once per ref — a repeated ref (a payment seen twice) changes nothing and returns false.
 */
export async function addWalletEntry(entry: {
  userId: string;
  organizationId?: string | null;
  kind: 'TOPUP' | 'ADJUST' | 'WELCOME' | 'REFUND' | 'GIFT';
  amount: bigint;
  ref: string;
  note?: string;
  createdById?: string;
}) {
  try {
    await prisma.$transaction([
      prisma.walletEntry.create({ data: entry }),
      prisma.wallet.upsert({
        where: { userId: entry.userId },
        create: { userId: entry.userId, balance: entry.amount },
        update: { balance: { increment: entry.amount } },
      }),
    ]);
  } catch (error: any) {
    if (error?.code === 'P2002') return false;
    throw error;
  }
  await syncAiCap(entry.userId).catch((error) => console.error('AI spend cap sync failed:', error));
  // a top-up starts stopped apps now, not at the next hourly check
  if (entry.amount > 0n) void guardWallet(entry.userId).catch((error) => console.error('Balance guard failed:', error));
  return true;
}

export class InsufficientBalance extends Error {
  constructor(public needed: bigint, public balance: bigint) {
    super(`Not enough balance: this costs Rp ${(needed / MICRO).toLocaleString('id-ID')}, the balance is Rp ${(balance / MICRO).toLocaleString('id-ID')}`);
  }
}

/**
 * Pay for a workspace's purchase (a domain, a renewal) from its payer's balance — all
 * of it, now, or not at all: unlike hosting it never goes below zero. Throws
 * InsufficientBalance. Once per ref: a repeated ref charges nothing and returns false.
 */
export async function spendFromWallet(entry: { organizationId: string; kind: 'DOMAIN'; amount: bigint; ref: string; note: string; createdById?: string }) {
  const userId = await payerIdOf(entry.organizationId);
  if (!userId) throw new InsufficientBalance(entry.amount, 0n);
  try {
    await prisma.$transaction(async (tx) => {
      // the entry first: a repeated ref fails here, before any money moves
      await tx.walletEntry.create({ data: { ...entry, userId, amount: -entry.amount } });
      const paid = await tx.$executeRaw`UPDATE "wallets" SET "balance" = "balance" - ${entry.amount}, "updatedAt" = now()
        WHERE "userId" = ${userId} AND "balance" >= ${entry.amount}`;
      if (!paid) {
        const wallet = await tx.wallet.findUnique({ where: { userId }, select: { balance: true } });
        throw new InsufficientBalance(entry.amount, wallet?.balance ?? 0n);
      }
    });
  } catch (error: any) {
    if (error?.code === 'P2002') return false;
    throw error;
  }
  await syncAiCap(userId).catch((error) => console.error('AI spend cap sync failed:', error));
  return true;
}

/** Give back what the entry `ref` took — a purchase the registrar refused — to the wallet it came from. Once. */
export async function refundCharge(ref: string, note: string) {
  const charge = await prisma.walletEntry.findUnique({ where: { ref }, select: { userId: true, organizationId: true, amount: true } });
  if (!charge || charge.amount >= 0n) return false;
  return addWalletEntry({ userId: charge.userId, organizationId: charge.organizationId, kind: 'REFUND', amount: -charge.amount, ref: `refund:${ref}`, note });
}

/** The welcome credit, into the user's wallet — once per user. */
export const grantWelcomeCredit = (userId: string) =>
  addWalletEntry({ userId, kind: 'WELCOME', amount: WELCOME_CREDIT, ref: `welcome:${userId}`, note: 'Welcome credit' });

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

/** The id of the user whose wallet pays a workspace; null when it has no OWNER. */
export const payerIdOf = async (organizationId: string) => (await billingUserOf(organizationId))?.id ?? null;

/**
 * The workspaces a user pays for: those they OWN where billingUserOf is them. ponytail:
 * one billingUserOf per owned workspace — a query per workspace, fine at tens.
 */
export async function paidWorkspaces(userId: string) {
  const owned = await prisma.membership.findMany({ where: { userId, role: 'OWNER' }, select: { organizationId: true } });
  const paid: string[] = [];
  for (const { organizationId } of owned) if ((await payerIdOf(organizationId)) === userId) paid.push(organizationId);
  return paid;
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
 * Charge each workspace its hosting to its payer's wallet, one entry per WIB day
 * (`host:<org>:<day>`), set to what the day cost so far — today and the last days
 * rewritten as readings arrive, the balance moved by the difference. From the cutover
 * on. A day stays with the wallet it was first charged to: a change of payer takes
 * effect from the next day, so an entry and the balance it moved never part.
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
    const userId = await payerIdOf(organizationId);
    // no OWNER, no one to charge
    if (!userId) continue;
    const days = await usageByDay(organizationId, start, end);
    const charges = [...days].map(([day, use]) => ({
      ref: `host:${organizationId}:${day}`,
      note: `Hosting · ${day}`,
      amount: BigInt(Math.round(priceOf(use, daysInMonthOf(day)).total * 1e6)),
    }));
    if (!charges.some((c) => c.amount > 0n)) continue;

    const deltas = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${HOSTING_LOCK})`;
      const deltas = new Map<string, bigint>();
      for (const c of charges) {
        const had = await tx.walletEntry.findUnique({ where: { ref: c.ref }, select: { amount: true, userId: true } });
        // mostly more as the day goes on; less when a reading replaced today's estimate
        const change = -c.amount - (had?.amount ?? 0n);
        if (change === 0n) continue;
        await tx.walletEntry.upsert({
          where: { ref: c.ref },
          create: { ref: c.ref, userId, organizationId, kind: 'HOSTING_USAGE', amount: -c.amount, note: c.note },
          update: { amount: -c.amount },
        });
        const who = had?.userId ?? userId;
        deltas.set(who, (deltas.get(who) ?? 0n) + change);
      }
      for (const [who, delta] of deltas) {
        await tx.wallet.upsert({
          where: { userId: who },
          create: { userId: who, balance: delta },
          update: { balance: { increment: delta } },
        });
      }
      return deltas;
    });
    if (deltas.size) {
      moved++;
      // what hosting took, AI can no longer spend
      for (const who of deltas.keys()) await syncAiCap(who).catch((error) => console.error(`AI spend cap sync failed (${who}):`, error));
    }
  }
  return `hosting charged to ${moved} of ${orgs.length} workspace(s)`;
}

// ── Running out ──

/** How far below zero hosting may go before the apps stop: 7 days of what it costs, at least Rp 10,000. */
export const negativeLimit = (perDay: bigint) => {
  const week = 7n * perDay;
  return week > 10_000n * MICRO ? week : 10_000n * MICRO;
};

type Notice = 'LOW' | 'NEGATIVE' | 'STOPPED';
export type GuardStep = { do: 'stop' | 'resume' | 'keep-stopped' | 'none'; notice: Notice | null; mail: boolean };

/**
 * What a workspace's balance calls for. Pure. perDay: what it costs a day now
 * (micro-IDR). A warning is mailed when it changes — LOW at 3 days left,
 * NEGATIVE again each day it stays below zero, STOPPED once.
 */
export function guardStep(w: { balance: bigint; perDay: bigint; suspended: boolean; notice: string | null; noticeAt: Date | null; now: number }): GuardStep {
  if (w.suspended) return w.balance > 0n ? { do: 'resume', notice: null, mail: false } : { do: 'keep-stopped', notice: 'STOPPED', mail: false };
  if (w.balance <= -negativeLimit(w.perDay)) return { do: 'stop', notice: 'STOPPED', mail: true };
  if (w.balance < 0n) {
    const daily = w.notice !== 'NEGATIVE' || !w.noticeAt || w.now - w.noticeAt.getTime() >= 20 * 3_600_000;
    return { do: 'none', notice: 'NEGATIVE', mail: daily };
  }
  if (w.perDay > 0n && w.balance < 3n * w.perDay) return { do: 'none', notice: 'LOW', mail: w.notice !== 'LOW' };
  return { do: 'none', notice: null, mail: false };
}

/** Days (one decimal) an amount lasts at perDay; null when nothing is spent. */
export const daysOf = (amount: bigint, perDay: bigint) => (perDay > 0n ? Number((amount * 10n) / perDay) / 10 : null);

/** What a workspace costs a day now (micro-IDR): its hosting at the current pace. */
export async function perDayOf(organizationId: string) {
  return BigInt(Math.round((await currentRate(organizationId)).perHour * 24 * 1e6));
}

/** What everything a user pays for costs a day now (micro-IDR). */
export async function perDayOfUser(userId: string, workspaces?: string[]) {
  let total = 0n;
  for (const organizationId of workspaces ?? (await paidWorkspaces(userId))) total += await perDayOf(organizationId);
  return total;
}

const deployments = new DeploymentService();
const rp = (micro: bigint) => `Rp ${Math.round(Number(micro) / 1e6).toLocaleString('id-ID')}`;

function balanceMail(notice: Notice, names: string[], balance: bigint, perDay: bigint) {
  const app = process.env.APP_NAME || 'Larika';
  const limit = rp(-negativeLimit(perDay));
  const left = daysOf(balance, perDay);
  const untilStop = daysOf(balance + negativeLimit(perDay), perDay);
  const which = names.length ? ` (${names.join(', ')})` : '';
  if (notice === 'LOW') {
    return {
      subject: `${app}: balance running low`,
      lines: [`Your balance on ${app} is ${rp(balance)}${left !== null ? ` — about ${left} days at ${rp(perDay)} a day` : ''}.`, `Top up to keep your workspaces' apps running${which}.`],
    };
  }
  if (notice === 'NEGATIVE') {
    return {
      subject: `${app}: balance below zero`,
      lines: [`Your balance on ${app} is ${rp(-balance)} below zero.`, `Your workspaces' apps${which} stop ${untilStop !== null ? `in about ${untilStop} days` : 'soon'}, at ${limit}. Top up to keep them running.`],
    };
  }
  return {
    subject: `${app}: apps stopped, balance used up`,
    lines: [`Your balance on ${app} went past ${limit}, so your workspaces' apps${which} were stopped. Nothing was deleted.`, 'Top up and they start again.'],
  };
}

/**
 * Check one user's balance: warn them, stop the apps of every workspace they pay for
 * past the negative limit (7 days of their total spend — the grace for their servers) —
 * and keep them stopped, a reboot starts units again — and start them once a top-up
 * brings it above zero. Off until hosting is charged.
 */
export async function guardWallet(userId: string): Promise<GuardStep['do']> {
  if (!hostingBillingFrom()) return 'none';
  const [user, wallet, workspaces] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
    prisma.wallet.findUnique({ where: { userId }, select: { balance: true, balanceNotice: true, balanceNoticeAt: true } }),
    paidWorkspaces(userId),
  ]);
  if (!user) return 'none';
  const orgs = await prisma.organization.findMany({ where: { id: { in: workspaces } }, select: { id: true, name: true, suspendedAt: true } });
  const balance = wallet?.balance ?? 0n;
  const perDay = await perDayOfUser(userId, workspaces);
  const suspended = orgs.some((o) => o.suspendedAt);
  const step = guardStep({ balance, perDay, suspended, notice: wallet?.balanceNotice ?? null, noticeAt: wallet?.balanceNoticeAt ?? null, now: Date.now() });

  for (const org of orgs) {
    if (step.do === 'stop' || step.do === 'keep-stopped') {
      if (!org.suspendedAt) await prisma.organization.update({ where: { id: org.id }, data: { suspendedAt: new Date() } });
      // panel-managed apps only: imported ones are run by their own server
      const running = await prisma.application.findMany({ where: { organizationId: org.id, runtime: null, status: 'RUNNING' }, select: { id: true } });
      for (const { id } of running) {
        if (await deployments.stopApplication(id)) await prisma.application.update({ where: { id }, data: { status: 'STOPPED', stoppedForBalance: true } });
      }
    }
    if (step.do === 'resume' && org.suspendedAt) {
      await prisma.organization.update({ where: { id: org.id }, data: { suspendedAt: null } });
      const stopped = await prisma.application.findMany({ where: { organizationId: org.id, stoppedForBalance: true }, select: { id: true } });
      for (const { id } of stopped) {
        const started = await deployments.startApplication(id);
        await prisma.application.update({ where: { id }, data: { status: started ? 'RUNNING' : 'ERROR', stoppedForBalance: false } });
      }
    }
  }

  if (step.notice !== (wallet?.balanceNotice ?? null) || step.mail) {
    await prisma.wallet.upsert({
      where: { userId },
      create: { userId, balanceNotice: step.notice, ...(step.mail && { balanceNoticeAt: new Date() }) },
      update: { balanceNotice: step.notice, ...(step.mail && { balanceNoticeAt: new Date() }) },
    });
  }
  if (step.mail && step.notice) {
    const mail = balanceMail(step.notice, orgs.map((o) => o.name), balance, perDay);
    const url = process.env.APP_URL ? `${process.env.APP_URL.replace(/\/$/, '')}/usage` : null;
    await sendMail({ to: user.email, subject: mail.subject, text: [...mail.lines, ...(url ? ['', url] : [])].join('\n') });
  }
  return step.do;
}

/** The cron's run: every user with a wallet, and every payer of a stopped workspace. */
export async function guardWallets(): Promise<string> {
  if (!hostingBillingFrom()) return 'skipped — HOSTING_BILLING_FROM is not set';
  const users = new Set((await prisma.wallet.findMany({ select: { userId: true } })).map((w) => w.userId));
  for (const { id } of await prisma.organization.findMany({ where: { suspendedAt: { not: null } }, select: { id: true } })) {
    const payer = await payerIdOf(id);
    if (payer) users.add(payer);
  }
  const done: Record<string, number> = {};
  for (const id of users) {
    const step = await guardWallet(id).catch((error) => {
      console.error(`Balance guard failed (${id}):`, error);
      return 'failed';
    });
    done[step] = (done[step] ?? 0) + 1;
  }
  return Object.entries(done).map(([k, n]) => `${n} ${k}`).join(', ') || 'no wallets';
}

/** Whether the workspace's apps are stopped for its balance: nothing starts until a top-up. */
export async function stoppedForBalance(organizationId: string | null) {
  if (!organizationId) return false;
  return !!(await prisma.organization.findUnique({ where: { id: organizationId }, select: { suspendedAt: true } }))?.suspendedAt;
}
