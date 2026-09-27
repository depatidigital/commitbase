import { promises as dns } from 'dns';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { convert } from 'html-to-text';
import { prisma } from '../lib/prisma';
import { decrypt } from '../lib/secretBox';
import { sendMail } from '../lib/mailer';
import { extractFields, Field, filterOf, firstHeader, headerMayMatch, isPrivateIp, renderTemplate, ruleMatches, type RuleFilter, searchTerms, senderVerified } from '../lib/emailRules';
import { gateway } from './larikaGatewayService';
import { EMAIL_WATCHER_RATES, WIB_MS } from './usageMeterService';
import { billingUserOf, InsufficientBalance, MICRO, spendFromWallet } from './walletService';

/**
 * Email Watcher ("Pantau Email"): one IMAP connection per mailbox that has an active
 * rule, idling in INBOX so the server tells us of new mail within seconds. Each new
 * message runs the mailbox's rules; a match is an EmailEvent, sent to the rule's
 * webhook and/or WhatsApp.
 *
 * - IDLE is restarted every 10 minutes and INBOX re-checked every 15, so a connection
 *   that died without a word is noticed; a server without IDLE is polled (imapflow).
 * - After any reconnect the watcher reads from lastUid on, so nothing is missed; a new
 *   UIDVALIDITY restarts at the newest message instead of replaying the mailbox.
 * - A refused login stops the mailbox (AUTH_FAILED) and mails its owner — retrying a
 *   wrong password gets the account locked or Larika's IP blocked.
 * - Other failures retry with backoff (5 s doubling to 5 min, jittered).
 *
 * Billing: each day a mailbox is watched costs EMAIL_WATCHER_RATES.mailboxDay, paid up front
 * from the payer's wallet when watching starts and by the hourly cron after that. No balance
 * → the mailbox is paused (never below zero, like AI and WA) and the payer is mailed.
 *
 * ponytail: in-process, like cron.ts — one backend instance only. Move startEmailWatchers
 * into its own entrypoint (larika-inbox.service) past a few hundred mailboxes.
 */

const IDLE_RESTART_MS = 10 * 60_000;
const SAFETY_CHECK_MS = 15 * 60_000;
const BOOT_JITTER_MS = 30_000;
/** mail older than this when first seen (a mailbox stopped for weeks) is skipped, not delivered late */
const MAX_AGE_MS = 3 * 86_400_000;
/** messages read per check; the next check carries on */
const BATCH = 200;
const RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
export const EVENT_RETENTION_DAYS = 90;

export type ImapSettings = { host: string; port: number; secure: boolean; username: string; password: string };

// ── Settings ──

const PRESETS: Array<[RegExp, string]> = [
  [/^(gmail|googlemail)\.com$/, 'imap.gmail.com'],
  [/^(yahoo|ymail)\.[a-z.]+$/, 'imap.mail.yahoo.com'],
  [/^(icloud|me|mac)\.com$/, 'imap.mail.me.com'],
  [/^zoho\.[a-z.]+$/, 'imap.zoho.com'],
];
const OAUTH_ONLY = /^(outlook|hotmail|live|msn)\.[a-z.]+$/;

/**
 * IMAP settings for an address: known providers, else by the domain's MX (Google
 * Workspace, Zoho), else mail.<domain> — the cPanel/hosting convention.
 */
export async function detectSettings(email: string): Promise<{ host: string; port: number; secure: boolean; provider: string | null; unsupported?: string }> {
  const domain = email.split('@')[1]?.toLowerCase().trim() ?? '';
  const base = { port: 993, secure: true };
  if (OAUTH_ONLY.test(domain)) return { ...base, host: 'outlook.office365.com', provider: 'outlook', unsupported: 'Outlook and Hotmail only allow sign-in with Microsoft, which is not supported yet' };
  for (const [re, host] of PRESETS) if (re.test(domain)) return { ...base, host, provider: host.split('.').slice(-2, -1)[0] ?? null };
  const mx = await dns.resolveMx(domain).catch(() => []);
  const exchange = mx.sort((a, b) => a.priority - b.priority)[0]?.exchange.toLowerCase() ?? '';
  if (/google(mail)?\.com$/.test(exchange)) return { ...base, host: 'imap.gmail.com', provider: 'google' };
  if (/zoho\.[a-z.]+$/.test(exchange)) return { ...base, host: 'imap.zoho.com', provider: 'zoho' };
  if (/outlook\.com$/.test(exchange)) return { ...base, host: 'outlook.office365.com', provider: 'outlook', unsupported: 'Microsoft 365 only allows sign-in with Microsoft, which is not supported yet' };
  return { ...base, host: domain ? `mail.${domain}` : '', provider: null };
}

/** A host the user typed must resolve to public addresses: never Larika's own network. */
export async function assertPublicHost(host: string) {
  const addresses = await dns.lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw new UserError(`${host} does not resolve`);
  if (addresses.some((a) => isPrivateIp(a.address))) throw new UserError(`${host} points to a private address`);
}

export async function assertPublicUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UserError('The webhook URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UserError('The webhook URL must start with https://');
  // ponytail: checked at save and at send; DNS that changes between the lookup and the fetch is not caught
  await assertPublicHost(url.hostname.replace(/^\[|\]$/g, ''));
}

/** A refusal worth showing the user as it is (400), not a server fault. */
export class UserError extends Error {}

const clientFor = (s: ImapSettings, watching = false) =>
  new ImapFlow({
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: { user: s.username, pass: s.password },
    logger: false,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    ...(watching ? { maxIdleTime: IDLE_RESTART_MS } : { disableAutoIdle: true }),
  });

const authFailed = (error: unknown) => !!(error as { authenticationFailed?: boolean })?.authenticationFailed;

const loginMessage = (error: unknown) =>
  authFailed(error)
    ? 'Login refused. Gmail, Yahoo and iCloud need an app password (with 2-step verification on), not the account password.'
    : `Could not connect: ${(error as Error)?.message ?? error}`;

/** Connect, run fn, log out. For the page's test and preview — not the watcher. */
async function withClient<T>(s: ImapSettings, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  await assertPublicHost(s.host);
  const client = clientFor(s);
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (error) {
    throw new UserError(loginMessage(error));
  }
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/** Log in and look at INBOX: where a new mailbox starts watching from. */
export async function testLogin(s: ImapSettings) {
  return withClient(s, async (client) => {
    const box = await client.mailboxOpen('INBOX', { readOnly: true });
    return { uidValidity: String(box.uidValidity), lastUid: Math.max(0, box.uidNext - 1), messages: box.exists };
  });
}

// ── Reading a message ──

/** HTML → text the fields can read: table cells apart ("Tujuan    DEPATI"), no image or link noise. */
const HTML_TEXT = {
  wordwrap: false as const,
  selectors: [
    { selector: 'table', format: 'dataTable', options: { uppercaseHeaderCells: false, maxColumnWidth: 200 } },
    { selector: 'img', format: 'skip' },
    { selector: 'a', options: { ignoreHref: true } },
  ],
};

type Parsed = { messageId: string; from: string; fromAddress: string | undefined; subject: string; text: string; date: Date; verified: boolean };

async function parse(source: Buffer, fallbackId: string): Promise<Parsed> {
  const mail = await simpleParser(source);
  const raw = source.toString('latin1', 0, Math.min(source.length, 64_000));
  const fromAddress = mail.from?.value[0]?.address;
  return {
    messageId: mail.messageId || fallbackId,
    from: mail.from?.text ?? '',
    fromAddress,
    subject: mail.subject ?? '',
    // an HTML-only email (bank notifications often are) is read as its text
    text: (mail.text || (mail.html ? convert(mail.html, HTML_TEXT) : '')).slice(0, 20_000),
    date: mail.date ?? new Date(),
    verified: senderVerified(firstHeader(raw, 'authentication-results'), fromAddress),
  };
}

const envelopeFrom = (env: { from?: Array<{ name?: string | undefined; address?: string | undefined }> | undefined } | undefined) =>
  (env?.from ?? []).map((a) => `${a.name ?? ''} <${a.address ?? ''}>`).join(', ');


/**
 * The rule editor's emails: the newest of the last days whose header the conditions may
 * take, read once over IMAP and kept a few minutes — the editor asks again on every
 * change, and a new field or body condition should not mean a new login.
 */
const PREVIEW_TTL_MS = 5 * 60_000;
const previewCache = new Map<string, { at: number; messages: Array<Parsed & { uid: number }> }>();

async function previewMessages(cacheKey: string, s: ImapSettings, rule: RuleFilter, days: number, limit: number) {
  // the body conditions change which emails pass, not which are read: left out of the key (OR still opens to them)
  const header = rule.conditions.filter((c) => c.field !== 'body');
  const key = `${cacheKey}|${rule.match}|${JSON.stringify(header).toLowerCase()}|${rule.match === 'any' && header.length < rule.conditions.length}|${days}|${limit}`;
  const hit = previewCache.get(key);
  if (hit && Date.now() - hit.at < PREVIEW_TTL_MS) return hit.messages;
  const messages = await withClient(s, async (client) => {
    await client.mailboxOpen('INBOX', { readOnly: true });
    const since = new Date(Date.now() - days * 86_400_000);
    // AND's plain "contains" narrows the search on the server; every condition is then
    // checked here on the newest 300 headers (OR, NOT, IN, regex cannot be searched)
    const uids = ((await client.search({ since, ...searchTerms(rule) }, { uid: true })) || []).sort((a, b) => b - a);
    let recent = uids.slice(0, limit);
    if (header.length) {
      const heads = uids.length ? await client.fetchAll(uids.slice(0, 300).join(','), { uid: true, envelope: true }, { uid: true }) : [];
      recent = heads
        .filter((m) => headerMayMatch(rule, { from: envelopeFrom(m.envelope), subject: m.envelope?.subject ?? '' }))
        .map((m) => m.uid)
        .sort((a, b) => b - a)
        .slice(0, limit);
    }
    if (!recent.length) return [];
    const fetched = await client.fetchAll(recent.join(','), { uid: true, source: { maxLength: 512_000 } }, { uid: true });
    const parsed = [];
    for (const msg of fetched.sort((a, b) => b.uid - a.uid)) if (msg.source) parsed.push({ uid: msg.uid, ...(await parse(msg.source, `uid:${msg.uid}`)) });
    return parsed;
  });
  // ponytail: a plain map, the oldest dropped past 50 entries — an editor's few minutes, not a store
  if (previewCache.size >= 50) previewCache.delete(previewCache.keys().next().value!);
  previewCache.set(key, { at: Date.now(), messages });
  return messages;
}

/**
 * A rule tried on real mail: every email whose header its conditions may take, whether
 * the whole rule takes it, and what the fields read out of it. Nothing is stored.
 */
export async function previewRule(cacheKey: string, s: ImapSettings, rule: RuleFilter & { fields: Field[] }, window: { days: number; limit: number } = { days: 60, limit: 30 }) {
  const fields = rule.fields;
  const messages = await previewMessages(cacheKey, s, rule, window.days, window.limit);
  return {
    rows: messages.map((m) => ({
      uid: m.uid,
      date: m.date,
      from: m.from,
      subject: m.subject,
      verified: m.verified,
      matched: ruleMatches(rule, m),
      text: m.text.slice(0, 5_000),
      data: extractFields(fields, m),
    })),
  };
}

// ── The watcher ──

type Watch = { client: ImapFlow | null; stopped: boolean; failures: number; timer?: NodeJS.Timeout; poll?: NodeJS.Timeout; queue: Promise<void> };
const watches = new Map<string, Watch>();

const settingsOf = (box: { host: string; port: number; secure: boolean; username: string; passwordEnc: string }): ImapSettings => ({
  host: box.host,
  port: box.port,
  secure: box.secure,
  username: box.username,
  password: decrypt(box.passwordEnc),
});

/** Every mailbox that should be watched, each after a random pause so a restart does not log in to all at once. */
export async function startEmailWatchers() {
  const boxes = await prisma.emailMailbox.findMany({ where: WATCHED, select: { id: true } });
  for (const { id } of boxes) start(id, Math.random() * BOOT_JITTER_MS);
  return boxes.length;
}

/** Mailboxes that are watched, so charged: not paused or locked out, with a rule on. */
const WATCHED = { status: { notIn: ['PAUSED', 'AUTH_FAILED'] }, rules: { some: { active: true } } };

export const NO_BALANCE = 'Paused: the balance does not cover today. Top up, then resume.';

/**
 * Watch or stop watching a mailbox to match what the database says now (after any change
 * to it or its rules). Starting charges today first; false when the balance did not cover
 * it and the mailbox was paused instead.
 */
export async function syncMailbox(id: string, restart = false) {
  if (restart) stop(id);
  const box = await prisma.emailMailbox.findFirst({ where: { id, ...WATCHED } });
  if (!box) return stop(id), true;
  if (!(await chargeToday(box))) return false;
  if (!watches.has(id)) start(id, 0);
  return true;
}

/** Today's (WIB) charge for a mailbox, once. false: not enough balance — the mailbox is paused and its payer mailed. */
async function chargeToday(box: { id: string; email: string; organizationId: string }) {
  const day = new Date(Date.now() + WIB_MS).toISOString().slice(0, 10);
  try {
    await spendFromWallet({
      organizationId: box.organizationId,
      kind: 'EMAIL_WATCHER',
      amount: BigInt(EMAIL_WATCHER_RATES.mailboxDay) * MICRO,
      ref: `email:${box.id}:${day}`,
      note: `Email Watcher ${box.email}, ${day}`,
    });
    return true;
  } catch (error) {
    if (!(error instanceof InsufficientBalance)) throw error;
    stop(box.id);
    await prisma.emailMailbox.update({ where: { id: box.id }, data: { status: 'PAUSED', lastError: NO_BALANCE } });
    const payer = await billingUserOf(box.organizationId);
    if (payer) {
      await sendMail({
        to: payer.email,
        subject: `Email Watcher paused: ${box.email}`,
        text: `Your balance does not cover today's Rp ${EMAIL_WATCHER_RATES.mailboxDay} for watching ${box.email}, so Larika stopped reading it.

Top up, then press Resume:
${(process.env.FRONTEND_URL || '').replace(/\/$/, '')}/email-watcher`,
      }).catch(() => undefined);
    }
    return false;
  }
}

/** Cron, hourly: each watched mailbox's day charged — the first run after midnight WIB charges the new day. */
export async function billEmailWatchers(): Promise<string> {
  const boxes = await prisma.emailMailbox.findMany({ where: WATCHED, select: { id: true, email: true, organizationId: true } });
  let paused = 0;
  for (const box of boxes) if (!(await chargeToday(box).catch((e) => (console.warn(`Email Watcher ${box.id}: charge failed:`, e), true)))) paused += 1;
  return `${boxes.length} mailbox(es) charged${paused ? `, ${paused} paused for balance` : ''}`;
}

export function stop(id: string) {
  const w = watches.get(id);
  if (!w) return;
  w.stopped = true;
  clearTimeout(w.timer);
  clearInterval(w.poll);
  const client = w.client;
  w.client = null;
  client?.logout().catch(() => client.close());
  watches.delete(id);
}

export const watchedCount = () => watches.size;

function start(id: string, delay: number) {
  const w: Watch = { client: null, stopped: false, failures: 0, queue: Promise.resolve() };
  watches.set(id, w);
  w.timer = setTimeout(() => void connect(id, w), delay);
}

/** Run one check at a time per mailbox: an EXISTS during a check waits for it. */
const enqueue = (id: string, w: Watch, client: ImapFlow) => {
  w.queue = w.queue.then(() => check(id, w, client)).catch((error) => console.warn(`Email watcher ${id}: check failed:`, error?.message ?? error));
  return w.queue;
};

async function connect(id: string, w: Watch) {
  if (w.stopped) return;
  const box = await prisma.emailMailbox.findUnique({ where: { id } }).catch(() => null);
  if (!box || w.stopped) return;
  let client: ImapFlow;
  try {
    client = clientFor(settingsOf(box), true);
  } catch (error) {
    return fail(id, w, error); // CB_SECRET_KEY missing or changed: retried, and said so
  }
  w.client = client;
  let down = false;
  const onDown = (error?: unknown) => {
    if (down || w.client !== client) return;
    down = true;
    w.client = null;
    clearInterval(w.poll);
    if (!w.stopped) void fail(id, w, error ?? new Error('Connection closed'));
  };
  client.on('error', (error) => onDown(error));
  client.on('close', () => onDown());
  client.on('exists', () => void enqueue(id, w, client));
  try {
    await client.connect();
    await client.mailboxOpen('INBOX');
  } catch (error) {
    onDown(error);
    return;
  }
  if (w.stopped) return void client.logout().catch(() => client.close());
  w.failures = 0;
  await prisma.emailMailbox.update({ where: { id }, data: { status: 'OK', lastError: null } }).catch(() => undefined);
  w.poll = setInterval(() => void enqueue(id, w, client), SAFETY_CHECK_MS);
  void enqueue(id, w, client);
}

async function fail(id: string, w: Watch, error: unknown) {
  if (w.stopped) return;
  const message = loginMessage(error).slice(0, 500);
  if (authFailed(error)) {
    stop(id);
    const box = await prisma.emailMailbox.update({ where: { id }, data: { status: 'AUTH_FAILED', lastError: message } }).catch(() => null);
    if (box) await mailAuthFailed(box).catch((e) => console.warn('Could not mail the mailbox owner:', e));
    return;
  }
  w.failures += 1;
  const delay = Math.min(5_000 * 2 ** (w.failures - 1), 5 * 60_000) * (0.75 + Math.random() * 0.5);
  await prisma.emailMailbox.update({ where: { id }, data: { status: 'ERROR', lastError: message } }).catch(() => undefined);
  w.timer = setTimeout(() => void connect(id, w), delay);
}

async function mailAuthFailed(box: { id: string; email: string; createdById: string | null; organizationId: string }) {
  const user = box.createdById ? await prisma.user.findUnique({ where: { id: box.createdById }, select: { email: true } }) : null;
  if (!user) return;
  const url = `${(process.env.FRONTEND_URL || '').replace(/\/$/, '')}/email-watcher`;
  await sendMail({
    to: user.email,
    subject: `Email Watcher stopped: ${box.email}`,
    text: `Larika could not log in to ${box.email} and has stopped watching it, so no new emails are read.\n\nThe password was probably changed or the app password revoked. Enter a new one here:\n${url}`,
  });
}

/** New messages since lastUid: each one through the mailbox's active rules. */
async function check(id: string, w: Watch, client: ImapFlow) {
  if (w.stopped || w.client !== client || !client.mailbox) return;
  const box = await prisma.emailMailbox.findUnique({ where: { id }, include: { rules: { where: { active: true } } } });
  if (!box) return;
  const uidValidity = String(client.mailbox.uidValidity);
  if (box.uidValidity !== uidValidity) {
    // renumbered (or never seen): start at the newest message, do not replay the mailbox
    await prisma.emailMailbox.update({ where: { id }, data: { uidValidity, lastUid: Math.max(0, client.mailbox.uidNext - 1), lastCheckedAt: new Date() } });
    return;
  }
  // `n:*` always returns the newest message, even when it is older than n
  const found = (await client.fetchAll(`${box.lastUid + 1}:*`, { uid: true, envelope: true, internalDate: true }, { uid: true }))
    .filter((m) => m.uid > box.lastUid)
    .sort((a, b) => a.uid - b.uid)
    .slice(0, BATCH);
  let lastUid = box.lastUid;
  for (const msg of found) {
    const at = msg.internalDate ? new Date(msg.internalDate) : new Date();
    const header = { from: envelopeFrom(msg.envelope), subject: msg.envelope?.subject ?? '' };
    const rules = box.rules.filter((r) => headerMayMatch(filterOf(r), header));
    if (rules.length && Date.now() - at.getTime() < MAX_AGE_MS) {
      const full = await client.fetchOne(String(msg.uid), { source: { maxLength: 512_000 } }, { uid: true });
      if (full && full.source) await record(rules, await parse(full.source, `uid:${uidValidity}:${msg.uid}`));
    }
    lastUid = msg.uid;
    await prisma.emailMailbox.update({ where: { id }, data: { lastUid } });
  }
  await prisma.emailMailbox.update({ where: { id }, data: { lastCheckedAt: new Date() } });
  if (found.length === BATCH) void enqueue(id, w, client);
}

type Rule = { id: string; name: string; match: string; conditions: unknown; onlyVerified: boolean; fields: unknown; webhookUrl: string | null; waNumberId: string | null; waTo: string | null };

async function record(rules: Rule[], m: Parsed) {
  for (const rule of rules) {
    if (!ruleMatches(filterOf(rule), m)) continue;
    const status = rule.onlyVerified && !m.verified ? 'SKIPPED' : !rule.webhookUrl && !(rule.waNumberId && rule.waTo) ? 'NO_TARGET' : 'PENDING';
    try {
      const event = await prisma.emailEvent.create({
        data: {
          ruleId: rule.id,
          messageId: m.messageId.slice(0, 500),
          from: m.from.slice(0, 500),
          subject: m.subject.slice(0, 1000),
          snippet: m.text.slice(0, 500),
          receivedAt: m.date,
          verified: m.verified,
          data: extractFields(rule.fields as Field[], m),
          status,
          nextAttemptAt: status === 'PENDING' ? new Date() : null,
          ...(status === 'SKIPPED' && { error: 'The sender could not be verified (no DKIM/DMARC pass for its domain)' }),
        },
      });
      if (status === 'PENDING') void deliver(event.id).catch((e) => console.warn(`Email event ${event.id}: delivery failed:`, e));
    } catch (error) {
      if ((error as { code?: string })?.code !== 'P2002') throw error; // P2002: seen already (a re-check)
    }
  }
}

// ── Delivery ──

/**
 * Send an event to its rule's webhook and WhatsApp, the ones not done yet. Claimed by
 * pushing nextAttemptAt out first, so the retry sweep and a fresh match never both send.
 * WhatsApp carries the event id as the gateway's ref: a retry never messages twice.
 */
export async function deliver(eventId: string) {
  const now = new Date();
  const claimed = await prisma.emailEvent.updateMany({
    where: { id: eventId, status: 'PENDING', nextAttemptAt: { lte: now } },
    data: { nextAttemptAt: new Date(now.getTime() + 5 * 60_000) },
  });
  if (!claimed.count) return;
  const ev = await prisma.emailEvent.findUnique({ where: { id: eventId }, include: { rule: { include: { mailbox: true } } } });
  if (!ev) return;
  const { rule } = ev;
  const errors: string[] = [];
  let webhookAt = ev.webhookAt;
  let waAt = ev.waAt;

  if (rule.webhookUrl && !webhookAt) {
    try {
      await assertPublicUrl(rule.webhookUrl);
      const body = JSON.stringify({
        event: 'email.matched',
        id: ev.id,
        rule: { id: rule.id, name: rule.name },
        mailbox: rule.mailbox.email,
        message: { id: ev.messageId, from: ev.from, subject: ev.subject, receivedAt: ev.receivedAt },
        verified: ev.verified,
        data: ev.data,
      });
      const response = await fetch(rule.webhookUrl, {
        method: 'POST',
        // the rule's key, as the WhatsApp gateway sends its number's: the app compares it
        headers: { 'content-type': 'application/json', 'x-larika-event': ev.id, 'x-larika-webhook-key': rule.webhookSecret },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      webhookAt = new Date();
    } catch (error) {
      errors.push(`Webhook: ${(error as Error).message}`);
    }
  }

  if (rule.waNumberId && rule.waTo && !waAt) {
    try {
      const number = await prisma.waNumber.findFirst({ where: { id: rule.waNumberId, organizationId: rule.mailbox.organizationId } });
      if (!number) throw new Error('the WhatsApp number was deleted');
      const vars = { ...(ev.data as Record<string, unknown>), subject: ev.subject, from: ev.from, rule: rule.name };
      const text = renderTemplate(rule.waTemplate || defaultTemplate(ev.data as Record<string, unknown>), vars).slice(0, 4096);
      await gateway(`/v1/instances/${number.instanceId}/messages`, { method: 'POST', body: { to: rule.waTo, text, ref: `email:${ev.id}` } });
      waAt = new Date();
    } catch (error) {
      errors.push(`WhatsApp: ${(error as Error).message}`);
    }
  }

  const attempts = ev.attempts + 1;
  const done = !errors.length;
  await prisma.emailEvent.update({
    where: { id: ev.id },
    data: {
      attempts,
      webhookAt,
      waAt,
      status: done ? 'DELIVERED' : attempts >= RETRY_MS.length ? 'FAILED' : 'PENDING',
      nextAttemptAt: done || attempts >= RETRY_MS.length ? null : new Date(Date.now() + RETRY_MS[attempts - 1]!),
      error: done ? null : errors.join('; ').slice(0, 1000),
    },
  });
}

const defaultTemplate = (data: Record<string, unknown>) => ['{rule}: {subject}', ...Object.keys(data).map((k) => `${k}: {${k}}`)].join('\n');

/** Cron: events whose retry is due. */
export async function retryDeliveries(): Promise<string> {
  const due = await prisma.emailEvent.findMany({ where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } }, select: { id: true }, take: 100 });
  for (const { id } of due) await deliver(id).catch((e) => console.warn(`Email event ${id}: delivery failed:`, e));
  return `${due.length} delivery(ies) tried, ${watches.size} mailbox(es) watched`;
}

/** Cron: events past retention — the transaction data in them should not sit here forever. */
export async function pruneEmailEvents(): Promise<string> {
  const { count } = await prisma.emailEvent.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - EVENT_RETENTION_DAYS * 86_400_000) } } });
  return `${count} event(s) pruned`;
}
