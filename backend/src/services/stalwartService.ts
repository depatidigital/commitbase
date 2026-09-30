import { prisma } from '../lib/prisma';
import { sendMail } from '../lib/mailer';
import { execRoot } from '../lib/runner';
import { getStalwartConfig } from './integrationConfigService';

/**
 * The Stalwart mail server, through its v1.0+ management API: JMAP methods
 * under urn:stalwart:jmap (x:Account/*, x:QueuedMessage/*) on /jmap, as its
 * admin. What it is for: seeing who fills the outgoing queue, cancelling
 * that mail, and locking the account — a mailbox whose password leaked sends
 * spam until then. And its log, read on the node, for the days behind.
 *
 * ponytail: no password reset — the app that provisions the mailboxes owns
 * their passwords (and its sync would overwrite one set here).
 */

type Config = NonNullable<Awaited<ReturnType<typeof getStalwartConfig>>>;
type MethodCall = [string, Record<string, unknown>, string];

export class StalwartError extends Error {}

async function config(): Promise<Config> {
  const c = await getStalwartConfig();
  if (!c) throw new StalwartError('Stalwart is not configured');
  return c;
}

async function jmap(c: Config, methodCalls: MethodCall[]): Promise<any[]> {
  const res = await fetch(`${c.baseUrl}/jmap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}` },
    // mail too: the admin reads and empties any account's folders with the standard methods
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap', 'urn:ietf:params:jmap:mail'], methodCalls }),
    // a flooded server answers slowly
    signal: AbortSignal.timeout(60_000),
  }).catch((error) => {
    throw new StalwartError(`Stalwart unreachable: ${error?.message || error}`);
  });
  if (res.status === 401) throw new StalwartError('Stalwart refused the admin login');
  if (!res.ok) throw new StalwartError(`Stalwart answered ${res.status}`);
  const responses: any[] = ((await res.json()) as any)?.methodResponses;
  if (!Array.isArray(responses)) throw new StalwartError('Malformed answer from Stalwart');
  const error = responses.find(([method]) => method === 'error');
  if (error) throw new StalwartError(`Stalwart: ${error[1]?.type}${error[1]?.description ? ` — ${error[1].description}` : ''}`);
  return responses;
}

/** One call that needs the admin role: saving the settings checks them with it. */
export async function checkStalwart(): Promise<string | null> {
  try {
    await jmap(await config(), [['x:QueuedMessage/query', { limit: 1 }, 'q']]);
    return null;
  } catch (error: any) {
    return error?.message || 'Stalwart check failed';
  }
}

// ── Queue ──

type Queued = { id: string; returnPath: string; receivedFromIp: string | null; recipients: Record<string, unknown> | null; createdAt: string };

/**
 * Every object of a kind: all ids in one query, then read 500 at a time.
 * Not paged by `position`: Stalwart answers every page from position 0 in no
 * fixed order, so pages overlap and miss objects.
 */
async function getAll(c: Config, kind: string, properties: string[]): Promise<any[]> {
  const q = await jmap(c, [[`${kind}/query`, {}, 'q']]);
  const ids: string[] = [...new Set<string>(q[0][1]?.ids ?? [])];
  const all: any[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const r = await jmap(c, [[`${kind}/get`, { ids: ids.slice(i, i + 500), properties }, 'g']]);
    all.push(...(r[0][1]?.list ?? []));
  }
  return all;
}

/** Every message waiting to go out. */
const queued = (c: Config): Promise<Queued[]> => getAll(c, 'x:QueuedMessage', ['returnPath', 'receivedFromIp', 'recipients', 'createdAt']);

export type QueueSender = { sender: string; messages: number; recipients: number; ips: Array<{ ip: string; messages: number }>; oldest: string };

/** The queue by sender, most messages first; the IPs it was handed in from, top five. Pure. */
export function queueBySender(list: Queued[]): QueueSender[] {
  const by = new Map<string, { messages: number; recipients: number; ips: Map<string, number>; oldest: string }>();
  for (const m of list) {
    const sender = m.returnPath || '<>';
    const row = by.get(sender) ?? { messages: 0, recipients: 0, ips: new Map(), oldest: m.createdAt };
    row.messages++;
    row.recipients += Object.keys(m.recipients ?? {}).length;
    if (m.receivedFromIp) row.ips.set(m.receivedFromIp, (row.ips.get(m.receivedFromIp) ?? 0) + 1);
    if (m.createdAt < row.oldest) row.oldest = m.createdAt;
    by.set(sender, row);
  }
  return [...by]
    .map(([sender, r]) => ({
      sender,
      messages: r.messages,
      recipients: r.recipients,
      ips: [...r.ips].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ip, messages]) => ({ ip, messages })),
      oldest: r.oldest,
    }))
    .sort((a, b) => b.messages - a.messages);
}

export async function getQueue() {
  const list = await queued(await config());
  return { total: list.length, senders: queueBySender(list) };
}

/**
 * Cancel every queued message from one sender. Rounds until none is left:
 * a flood keeps adding while the first round runs.
 */
export async function cancelQueue(sender: string): Promise<number> {
  const c = await config();
  let cancelled = 0;
  for (let round = 0; round < 5; round++) {
    const ids = (await queued(c)).filter((m) => (m.returnPath || '<>') === sender).map((m) => m.id);
    if (!ids.length) break;
    for (let i = 0; i < ids.length; i += 500) {
      const r = await jmap(c, [['x:QueuedMessage/set', { destroy: ids.slice(i, i + 500) }, 'd']]);
      // gone meanwhile (delivered, expired) counts as done
      cancelled += (r[0][1]?.destroyed ?? []).length;
    }
  }
  return cancelled;
}

// ── Accounts ──

/**
 * The ordinary user account with exactly this address. Every action here goes
 * through it: an admin or a group is never changed from here.
 */
async function findUser(c: Config, email: string): Promise<{ id: string; email: string; quotas: Record<string, number> }> {
  const address = email.trim().toLowerCase();
  const local = address.split('@')[0];
  if (!local || !address.includes('@')) throw new StalwartError('Not an email address');
  const r = await jmap(c, [
    ['x:Account/query', { filter: { name: local } }, 'q'],
    ['x:Account/get', { '#ids': { resultOf: 'q', name: 'x:Account/query', path: '/ids' }, properties: ['@type', 'name', 'emailAddress', 'roles', 'quotas'] }, 'g'],
  ]);
  // the filter is a search: the exact address decides
  const account = (r[1][1]?.list ?? []).find((a: any) => String(a.emailAddress ?? '').toLowerCase() === address);
  if (!account) throw new StalwartError(`No account ${address}`);
  if (account['@type'] !== 'User' || (account.roles?.['@type'] && account.roles['@type'] !== 'User')) {
    throw new StalwartError(`${address} is not an ordinary user; change it in Stalwart itself`);
  }
  return { id: account.id, email: address, quotas: account.quotas ?? {} };
}

async function updateUser(c: Config, id: string, patch: Record<string, unknown>, what: string) {
  const s = await jmap(c, [['x:Account/set', { update: { [id]: patch } }, 's']]);
  if (!s[0][1]?.updated || !(id in s[0][1].updated)) {
    const e = s[0][1]?.notUpdated?.[id];
    throw new StalwartError(`Stalwart did not ${what}${e ? `: ${e.type}${e.description ? ` — ${e.description}` : ''}` : ''}`);
  }
}

/**
 * Lock a mailbox: every credential removed (password, app passwords, API
 * keys), so nothing logs in as it any more. The mailbox and its mail stay.
 */
export async function lockAccount(email: string): Promise<{ id: string; email: string }> {
  const c = await config();
  const account = await findUser(c, email);
  await updateUser(c, account.id, { credentials: {} }, `lock ${account.email}`);
  return { id: account.id, email: account.email };
}

/** Cap what a mailbox's mail may take (bytes); null lifts the cap. Its other quotas stay as they are. */
export async function setDiskQuota(email: string, bytes: number | null): Promise<void> {
  const c = await config();
  const account = await findUser(c, email);
  const { maxDiskQuota: _old, ...others } = account.quotas;
  await updateUser(c, account.id, { quotas: bytes ? { ...others, maxDiskQuota: Math.floor(bytes) } : others }, `set the quota of ${account.email}`);
}

/**
 * Delete a mailbox and all its mail, for good. Nothing to undo it with: the
 * caller confirms by typing the address. An app that provisions mailboxes may
 * create it again at its next sync.
 */
export async function deleteMailbox(email: string): Promise<void> {
  const c = await config();
  const account = await findUser(c, email);
  const r = await jmap(c, [['x:Account/set', { destroy: [account.id] }, 'd']]);
  if (!(r[0][1]?.destroyed ?? []).includes(account.id)) {
    const e = r[0][1]?.notDestroyed?.[account.id];
    throw new StalwartError(`Stalwart did not delete ${account.email}${e ? `: ${e.type}` : ''}`);
  }
}

// ── Folders ──

// an empty running per folder, with how far it got
// ponytail: in memory — a panel restart stops it; starting it again goes on where it stopped
const emptying = new Map<string, { deleted: number; running: boolean; error: string | null }>();

export type Folder = { id: string; name: string; role: string | null; emails: number; emptying: { deleted: number; running: boolean; error: string | null } | null };

/** A mailbox's folders with how many messages each holds, and any empty running on them. */
export async function mailboxFolders(email: string): Promise<Folder[]> {
  const c = await config();
  const account = await findUser(c, email);
  const r = await jmap(c, [['Mailbox/get', { accountId: account.id, properties: ['name', 'role', 'totalEmails'] }, 'm']]);
  return (r[0][1]?.list ?? [])
    .map((m: any) => ({ id: m.id, name: m.name, role: m.role ?? null, emails: Number(m.totalEmails) || 0, emptying: emptying.get(`${account.id}/${m.id}`) ?? null }))
    .sort((a: Folder, b: Folder) => b.emails - a.emails);
}

/**
 * Delete every message in one folder, in the background: a flooded inbox
 * holds hundreds of thousands, far more than one request waits for. The
 * messages are gone for good, not moved to the trash.
 */
export async function emptyFolder(email: string, folderId: string): Promise<void> {
  const c = await config();
  const account = await findUser(c, email);
  const key = `${account.id}/${folderId}`;
  if (emptying.get(key)?.running) return;
  const state = { deleted: 0, running: true, error: null as string | null };
  emptying.set(key, state);
  void (async () => {
    try {
      for (;;) {
        const r = await jmap(c, [
          ['Email/query', { accountId: account.id, filter: { inMailbox: folderId }, limit: 500 }, 'q'],
          ['Email/set', { accountId: account.id, '#destroy': { resultOf: 'q', name: 'Email/query', path: '/ids' } }, 'd'],
        ]);
        const destroyed = (r[1][1]?.destroyed ?? []).length;
        state.deleted += destroyed;
        if (!(r[0][1]?.ids ?? []).length || !destroyed) break;
      }
    } catch (error: any) {
      state.error = error?.message || String(error);
    } finally {
      state.running = false;
      console.log(`Stalwart: emptied ${state.deleted} message(s) from ${account.email} folder ${folderId}${state.error ? ` (stopped: ${state.error})` : ''}`);
    }
  })();
}

export type Mailbox = {
  id: string;
  email: string;
  description: string | null;
  type: string;
  role: string | null;
  /** bytes its mail takes */
  usedBytes: number;
  /** the cap on it, null when none */
  quotaBytes: number | null;
  /** how it can log in — password, app password, API key; none means locked */
  credentials: string[];
  createdAt: string | null;
};

/** Every account, most disk first. Credentials by kind only: their secrets never leave this function. */
export async function listMailboxes(): Promise<Mailbox[]> {
  const c = await config();
  const all: Mailbox[] = [];
  {
    for (const a of await getAll(c, 'x:Account', ['@type', 'name', 'emailAddress', 'description', 'roles', 'usedDiskQuota', 'quotas', 'credentials', 'createdAt'])) {
      all.push({
        id: a.id,
        email: a.emailAddress || a.name,
        description: a.description && a.description !== a.name ? a.description : null,
        type: a['@type'] ?? 'User',
        role: a.roles?.['@type'] ?? null,
        usedBytes: Number(a.usedDiskQuota) || 0,
        quotaBytes: Number(a.quotas?.maxDiskQuota) || null,
        credentials: Object.values(a.credentials ?? {}).map((cred: any) => String(cred?.['@type'] ?? 'Password')),
        createdAt: a.createdAt ?? null,
      });
    }
  }
  return all.sort((a, b) => b.usedBytes - a.usedBytes);
}

// ── Allowed IPs ──

const NODE_REASON = 'larika-node';

/**
 * Keep every node's address on Stalwart's allowed-IP list, so our own apps
 * sending through it are never rate-limited or banned — and take one off the
 * blocked list if it already was. Entries we made carry NODE_REASON; stale ones
 * (a node that left) go unless `prune` is off; anyone else's are left alone.
 * Best effort, never throws.
 */
export async function syncStalwartAllowedIps(ips: string[], { prune = true } = {}): Promise<void> {
  const c = await getStalwartConfig();
  if (!c) return;
  try {
    const wanted = new Set(ips.map((ip) => ip.trim()).filter(Boolean));
    const r = await jmap(c, [
      ['x:AllowedIp/get', {}, 'a'],
      ['x:BlockedIp/get', {}, 'b'],
    ]);
    const allowed: Array<{ id: string; address: string; reason: string | null }> = r[0][1]?.list ?? [];
    const blocked: Array<{ id: string; address: string }> = r[1][1]?.list ?? [];
    const have = new Set(allowed.map((a) => a.address));

    const create = Object.fromEntries([...wanted].filter((ip) => !have.has(ip)).map((address, i) => [`n${i}`, { address, reason: NODE_REASON }]));
    const stale = prune ? allowed.filter((a) => a.reason === NODE_REASON && !wanted.has(a.address)).map((a) => a.id) : [];
    const unblock = blocked.filter((b) => wanted.has(b.address)).map((b) => b.id);
    if (Object.keys(create).length || stale.length) {
      const s = await jmap(c, [['x:AllowedIp/set', { create, destroy: stale }, 's']]);
      const refused = Object.entries(s[0][1]?.notCreated ?? {});
      if (refused.length) console.warn(`Stalwart allowed IPs: ${refused.map(([k, e]: any) => `${create[k]?.address}: ${e?.type} ${e?.description ?? ''}`).join('; ')}`);
    }
    if (unblock.length) await jmap(c, [['x:BlockedIp/set', { destroy: unblock }, 'u']]);
  } catch (error: any) {
    console.warn(`Stalwart allowed IPs: ${error?.message || error}`);
  }
}

// ── Log ──

/**
 * One day's log, read on the node in a single pass, the answer only the
 * totals: a flooded day is gigabytes. Per sender (`from = "…"`): its messages
 * (distinct queueId), distinct recipients, and log lines. $1 the log folder,
 * $2 the day; the day's file and any copies logrotate made of it.
 */
export const LOG_SENDERS = `cat -- "$1/stalwart.$2" "$1/stalwart.$2".* 2>/dev/null | awk '
  { if (!match($0, /from = "[^"]*"/)) next; f = substr($0, RSTART + 8, RLENGTH - 9); lines[f]++
    if (match($0, /queueId = [0-9]+/)) { q = substr($0, RSTART + 10, RLENGTH - 10); if (!((f, q) in sq)) { sq[f, q] = 1; msgs[f]++ } }
    if (match($0, /to = \\["[^"]*/)) { t = substr($0, RSTART + 7, RLENGTH - 7); if (!((f, t) in st)) { st[f, t] = 1; rcpt[f]++ } } }
  END { for (f in lines) printf "%s\\t%d\\t%d\\t%d\\n", f, msgs[f], rcpt[f], lines[f] }' | sort -t "$(printf '\\t')" -k2,2nr | head -n 100`;

export type LogSender = { sender: string; messages: number; recipients: number; lines: number };

/** `sender \\t messages \\t recipients \\t lines` rows. Pure. */
export const parseLogSenders = (stdout: string): LogSender[] =>
  stdout
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((cols) => cols.length === 4)
    .map(([sender, messages, recipients, lines]) => ({ sender: sender || '<>', messages: Number(messages), recipients: Number(recipients), lines: Number(lines) }));

export async function logSenders(day: string): Promise<LogSender[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new StalwartError('The day looks like 2026-09-30');
  const c = await config();
  if (!c.serverId) throw new StalwartError('Pick the node Stalwart runs on to read its log');
  const server = await prisma.server.findUnique({ where: { id: c.serverId } });
  if (!server) throw new StalwartError('The Stalwart node is gone; pick it again');
  const { stdout } = await execRoot(server, ['sh', '-c', LOG_SENDERS, 'sh', c.logDir, day], { timeout: 10 * 60_000 });
  return parseLogSenders(stdout);
}

// ── Alert ──

const DAY_MS = 24 * 60 * 60_000;
// ponytail: in memory, like the low-disk mail — a panel restart can mail once more
const alertedAt = new Map<string, number>();

/** Mail the platform's admins when one sender has more than the threshold waiting: a leaked password, most likely. Once a day per sender. */
export async function alertQueueFloods(): Promise<string> {
  const c = await getStalwartConfig();
  if (!c) return 'skipped — Stalwart not configured';
  const { total, senders } = await getQueue();
  const floods = senders.filter((s) => s.messages >= c.alertThreshold && Date.now() - (alertedAt.get(s.sender) ?? 0) > DAY_MS);
  if (floods.length) {
    const admins = await prisma.user.findMany({ where: { role: 'SUPERADMIN' }, select: { email: true } });
    const url = process.env.APP_URL ? `${process.env.APP_URL.replace(/\/$/, '')}/integrations/stalwart` : null;
    for (const s of floods) {
      alertedAt.set(s.sender, Date.now());
      for (const { email } of admins) {
        await sendMail({
          to: email,
          subject: `Mail flood: ${s.sender} has ${s.messages} messages queued`,
          text: [
            `${s.sender} has ${s.messages} messages (${s.recipients} recipients) waiting in Stalwart's outgoing queue.`,
            `Handed in from: ${s.ips.map((i) => `${i.ip} (${i.messages})`).join(', ') || 'unknown'}.`,
            'Many IPs sending as one account means its password leaked. Lock the account and cancel its queue.',
            ...(url ? ['', url] : []),
          ].join('\n'),
        });
      }
    }
  }
  return `${total} queued${floods.length ? ` — alerted: ${floods.map((s) => s.sender).join(', ')}` : ''}`;
}
