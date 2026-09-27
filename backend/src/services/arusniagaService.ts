import { prisma } from '../lib/prisma';
import { getArusniagaConfig } from './integrationConfigService';
import { addWalletEntry, MICRO } from './walletService';
import { WIB_MS } from './usageMeterService';

/**
 * ArusNiaga (erp.depatidigital.com): the ERP that issues Larika's invoices. A top-up is a
 * sales invoice there, paid on its public invoice page; when ArusNiaga shows it paid, the
 * wallet is credited once. Its public API: `X-API-Key`, answers `{ success, data }` or
 * `{ error }`.
 */

export class ArusniagaError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function arusniaga<T = any>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const config = await getArusniagaConfig();
  if (!config) throw new ArusniagaError('The ArusNiaga integration is not set up', 503);
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'x-api-key': config.apiKey, ...(init.body !== undefined && { 'content-type': 'application/json' }) },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
    });
  } catch (error: any) {
    throw new ArusniagaError(`ArusNiaga unreachable: ${error?.message || error}`, 502);
  }
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = response.status === 401 ? 'ArusNiaga rejected the API key' : body?.error || body?.message || `ArusNiaga answered ${response.status}`;
    throw new ArusniagaError(message, response.status);
  }
  return (body?.data ?? body) as T;
}

/** The business the API key issues invoices for — also how a saved key is checked. */
export const arusniagaBusiness = () => arusniaga<{ id: string; name: string; code: string | null }>('/api/public/business');

// ── Top-ups ──

/** Rupiah, whole. */
export const TOPUP_MIN = 50_000;
export const TOPUP_MAX = 100_000_000;
/** A top-up not paid in this long stops being checked (ArusNiaga still has the invoice). */
const TOPUP_CHECK_DAYS = 14;

/** The user as an ArusNiaga customer: created on their first top-up, remembered on their wallet. */
async function contactFor(userId: string) {
  const wallet = await prisma.wallet.findUnique({ where: { userId }, select: { arusniagaContactId: true } });
  if (wallet?.arusniagaContactId) return wallet.arusniagaContactId;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true, email: true } });
  const contact = await arusniaga<{ id: string }>('/api/public/contacts', {
    method: 'POST',
    body: { name: user.name || user.email, email: user.email, isClient: true },
  });
  await prisma.wallet.upsert({
    where: { userId },
    create: { userId, arusniagaContactId: contact.id },
    update: { arusniagaContactId: contact.id },
  });
  return contact.id;
}

type Invoice = { id: string; reference: string | null; status: string; grandTotal: number; remainingAmount: number; invoiceUrl: string | null };

/**
 * A top-up of `rupiah` into `userId`'s wallet (made from `organizationId`, if any): the
 * TopUp row, then its invoice in ArusNiaga (the row's id as the idempotency key, so a
 * retry cannot issue two). Returns the row with the invoice's page.
 */
export async function createTopUp(userId: string, organizationId: string | null, rupiah: number, createdById: string) {
  const topUp = await prisma.topUp.create({ data: { userId, organizationId, amount: BigInt(rupiah) * MICRO, createdById } });
  try {
    const contactId = await contactFor(userId);
    const today = new Date(Date.now() + WIB_MS).toISOString().slice(0, 10);
    const due = new Date(Date.now() + WIB_MS + 86_400_000).toISOString().slice(0, 10);
    const invoice = await arusniaga<Invoice>('/api/public/sales-invoices', {
      method: 'POST',
      body: {
        transactionDate: today,
        dueDate: due,
        contactId,
        description: 'Top-up saldo Larika',
        idempotencyKey: `larika-topup:${topUp.id}`,
        // ponytail: taken up once ArusNiaga ships bank transfer with a unique code
        // (docs/plans/bank-transfer-unique-code.md there); ignored until then
        paymentMethod: 'BANK_TRANSFER',
        status: 'CONFIRMED',
        items: [{ description: 'Top-up saldo Larika', quantity: 1, unitPrice: rupiah, unit: 'saldo' }],
      },
    });
    return prisma.topUp.update({
      where: { id: topUp.id },
      data: { invoiceId: invoice.id, invoiceRef: invoice.reference, invoiceUrl: invoice.invoiceUrl, invoiceTotal: invoice.grandTotal },
    });
  } catch (error) {
    await prisma.topUp.update({ where: { id: topUp.id }, data: { status: 'CANCELLED' } });
    throw error;
  }
}

/** A top-up's invoice paid in full: credit the wallet (once — the entry's ref), mark it paid. */
async function settleTopUp(topUp: { id: string; userId: string; amount: bigint; invoiceRef: string | null }) {
  await addWalletEntry({
    userId: topUp.userId,
    kind: 'TOPUP',
    amount: topUp.amount,
    ref: `topup:${topUp.id}`,
    note: `Top-up${topUp.invoiceRef ? ` · ${topUp.invoiceRef}` : ''}`,
  });
  await prisma.topUp.update({ where: { id: topUp.id }, data: { status: 'PAID', paidAt: new Date(), checkedAt: new Date() } });
}

/**
 * Ask ArusNiaga about every pending top-up: paid in full → credited; cancelled there →
 * cancelled here; unpaid for TOPUP_CHECK_DAYS → expired. ponytail: polling, one call per
 * pending top-up a minute; a webhook from ArusNiaga when it has one.
 */
export async function checkTopUps(): Promise<string> {
  if (!(await getArusniagaConfig())) return 'skipped — ArusNiaga is not set up';
  const pending = await prisma.topUp.findMany({ where: { status: 'PENDING', invoiceId: { not: null } }, orderBy: { createdAt: 'asc' }, take: 200 });
  let paid = 0;
  for (const topUp of pending) {
    try {
      const invoice = await arusniaga<Invoice>(`/api/public/sales-invoices/${topUp.invoiceId}`);
      if (invoice.grandTotal > 0 && invoice.remainingAmount <= 0) {
        await settleTopUp(topUp);
        paid++;
      } else if (invoice.status === 'CANCELLED') {
        await prisma.topUp.update({ where: { id: topUp.id }, data: { status: 'CANCELLED', checkedAt: new Date() } });
      } else if (Date.now() - topUp.createdAt.getTime() > TOPUP_CHECK_DAYS * 86_400_000) {
        await prisma.topUp.update({ where: { id: topUp.id }, data: { status: 'EXPIRED', checkedAt: new Date() } });
      } else {
        await prisma.topUp.update({ where: { id: topUp.id }, data: { checkedAt: new Date() } });
      }
    } catch (error: any) {
      // the invoice is gone there: nothing will pay it
      if (error instanceof ArusniagaError && error.status === 404) await prisma.topUp.update({ where: { id: topUp.id }, data: { status: 'CANCELLED', checkedAt: new Date() } });
      else console.error(`Top-up ${topUp.id} check failed:`, error?.message ?? error);
    }
  }
  return `${pending.length} pending top-up(s), ${paid} paid`;
}

/** A top-up as the panel shows it: money as strings (BigInt). */
export const topUpView = (t: { id: string; userId: string; organizationId: string | null; amount: bigint; status: string; invoiceRef: string | null; invoiceUrl: string | null; invoiceTotal: number | null; createdAt: Date; paidAt: Date | null }) => ({
  id: t.id,
  userId: t.userId,
  organizationId: t.organizationId,
  amount: String(t.amount),
  status: t.status,
  invoiceRef: t.invoiceRef,
  invoiceUrl: t.invoiceUrl,
  invoiceTotal: t.invoiceTotal,
  createdAt: t.createdAt,
  paidAt: t.paidAt,
});
