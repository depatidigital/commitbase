import { randomBytes } from 'crypto';
import { Router, Response } from 'express';
import { AuthenticatedRequest, authenticateToken } from '../middleware/auth';
import { ApiResponse } from '../types';
import { prisma } from '../lib/prisma';
import { canEncrypt, decrypt, encrypt } from '../lib/secretBox';
import { paging, paginated } from '../lib/paging';
import { canManageOrg, getOrgRole, isPlatformAdmin, listMemberships, orgScope } from '../lib/scope';
import { validFields } from '../lib/emailRules';
import { payerIdOf } from '../services/walletService';
import {
  assertPublicHost,
  assertPublicUrl,
  deliver,
  detectSettings,
  EVENT_RETENTION_DAYS,
  NO_BALANCE,
  ImapSettings,
  previewRule,
  stop,
  syncMailbox,
  testLogin,
  UserError,
} from '../services/emailWatcherService';

// Email Watcher ("Pantau Email"): a workspace's mailboxes, their rules and the events
// the rules matched. Members see the mailboxes; owners and admins manage them and
// see the events — those carry the contents of the user's mail. A watched mailbox is
// charged by the day to the workspace payer's wallet (emailWatcherService).
const router: Router = Router();
router.use(authenticateToken);

const bad = (res: Response, error: string, status = 400) => res.status(status).json({ success: false, error } as ApiResponse);

const fail = (res: Response, error: unknown) => {
  if (error instanceof UserError) return bad(res, error.message);
  console.error('Email Watcher request failed:', error);
  return bad(res, 'Something went wrong', 500);
};

/** The mailbox, when the caller may manage it; else null. */
async function mailboxFor(req: AuthenticatedRequest, id: unknown) {
  const box = await prisma.emailMailbox.findFirst({ where: { id: String(id), ...(await orgScope(req)) } });
  if (!box || !(await canManageOrg(req, box.organizationId))) return null;
  return box;
}

async function ruleFor(req: AuthenticatedRequest, id: unknown) {
  const rule = await prisma.emailRule.findUnique({ where: { id: String(id) }, include: { mailbox: true } });
  if (!rule || !(await mailboxFor(req, rule.mailboxId))) return null;
  return rule;
}

/** IMAP settings from a body: host, port, TLS, username (the address by default) and password. */
function settingsFrom(body: any, email: string, current?: ImapSettings): ImapSettings | string {
  const host = String(body?.host ?? current?.host ?? '').trim().toLowerCase();
  const port = Number(body?.port ?? current?.port ?? 993);
  const username = String(body?.username ?? current?.username ?? email).trim();
  const password = String(body?.password ?? '').replace(/\s+/g, '') || current?.password || '';
  if (!/^[a-z0-9.-]{3,253}$/.test(host)) return 'Enter the IMAP server, like imap.gmail.com';
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Enter the IMAP port, usually 993';
  if (!username || username.length > 254) return 'Enter the username, usually the email address';
  if (!password || password.length > 500) return 'Enter the password or app password';
  return { host, port, secure: body?.secure === undefined ? (current?.secure ?? port === 993) : !!body.secure, username, password };
}

/** A rule from a body: filters, fields, targets. `partial`: only what is given (PATCH). */
async function ruleFrom(body: any, organizationId: string, partial = false) {
  const data: Record<string, unknown> = {};
  const text = (key: string, max: number) => {
    if (body?.[key] === undefined) return;
    const value = String(body[key] ?? '').trim();
    if (value.length > max) throw new UserError(`${key} is too long`);
    data[key] = value;
  };
  if (!partial || body?.name !== undefined) {
    const name = String(body?.name ?? '').trim();
    if (!name || name.length > 80) throw new UserError('Name the rule (up to 80 characters)');
    data.name = name;
  }
  text('fromContains', 200);
  text('subjectContains', 200);
  text('bodyContains', 200);
  if (!partial && !data.fromContains && !data.subjectContains) throw new UserError('Filter on the sender or the subject, so the rule does not take every email');
  if (body?.onlyVerified !== undefined) data.onlyVerified = !!body.onlyVerified;
  if (body?.active !== undefined) data.active = !!body.active;
  if (body?.fields !== undefined) {
    const fields = validFields(body.fields);
    if (typeof fields === 'string') throw new UserError(fields);
    data.fields = fields;
  }
  if (body?.webhookUrl !== undefined) {
    const url = String(body.webhookUrl ?? '').trim();
    if (url) await assertPublicUrl(url);
    data.webhookUrl = url || null;
  }
  if (body?.waNumberId !== undefined) {
    const id = String(body.waNumberId ?? '').trim();
    if (id && !(await prisma.waNumber.findFirst({ where: { id, organizationId }, select: { id: true } }))) {
      throw new UserError('Pick a WhatsApp number of this workspace');
    }
    data.waNumberId = id || null;
  }
  if (body?.waTo !== undefined) {
    const to = String(body.waTo ?? '').replace(/[\s+-]/g, '');
    if (to && !/^[0-9]{7,20}$/.test(to)) throw new UserError('Enter the WhatsApp number to notify, like 628123456789');
    data.waTo = to || null;
  }
  text('waTemplate', 2000);
  if (data.waTemplate === '') data.waTemplate = null;
  return data;
}

const mailboxView = (box: any, canManage: boolean) => ({
  id: box.id,
  email: box.email,
  host: box.host,
  port: box.port,
  secure: box.secure,
  username: box.username,
  status: box.status,
  lastError: box.lastError,
  lastCheckedAt: box.lastCheckedAt,
  createdAt: box.createdAt,
  organization: box.organization,
  canManage,
  ...(box._count && { rules: box._count.rules }),
});

// ── Mailboxes ──

router.get('/detect', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const email = String(req.query.email ?? '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, 'Enter an email address');
    return res.json({ success: true, data: await detectSettings(email) } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/mailboxes', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rows = await prisma.emailMailbox.findMany({
      where: await orgScope(req),
      include: { organization: { select: { id: true, name: true } }, _count: { select: { rules: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const data = await Promise.all(rows.map(async (box) => mailboxView(box, await canManageOrg(req, box.organizationId))));
    return res.json({ success: true, data } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/mailboxes', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!canEncrypt()) return bad(res, 'The panel has no CB_SECRET_KEY, so it cannot store a mailbox password', 503);
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return bad(res, 'Enter an email address');
    const settings = settingsFrom(req.body, email);
    if (typeof settings === 'string') return bad(res, settings);

    // the workspace: the one asked for, else the only one
    const memberships = await listMemberships(req);
    const organizationId = String(req.body?.organizationId || (memberships.length === 1 ? memberships[0]!.organizationId : ''));
    if (!organizationId) return bad(res, 'Pick the workspace this mailbox belongs to');
    if (!isPlatformAdmin(req) && !(await getOrgRole(req, organizationId))) return bad(res, 'Workspace not found', 404);
    if (!(await canManageOrg(req, organizationId))) return bad(res, 'Only workspace owners and admins add mailboxes', 403);

    if (!(await payerIdOf(organizationId))) return bad(res, 'This workspace has no owner to pay for it');

    const start = await testLogin(settings);
    const box = await prisma.emailMailbox.create({
      data: {
        organizationId,
        email,
        host: settings.host,
        port: settings.port,
        secure: settings.secure,
        username: settings.username,
        passwordEnc: encrypt(settings.password),
        uidValidity: start.uidValidity,
        lastUid: start.lastUid,
        createdById: req.user!.userId,
      },
    });
    return res.status(201).json({ success: true, data: { id: box.id } } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/mailboxes/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const box = await mailboxFor(req, req.params.id);
    if (!box) return bad(res, 'Mailbox not found', 404);
    const [organization, rules, waNumbers] = await Promise.all([
      prisma.organization.findUnique({ where: { id: box.organizationId }, select: { id: true, name: true } }),
      prisma.emailRule.findMany({ where: { mailboxId: box.id }, orderBy: { createdAt: 'asc' } }),
      prisma.waNumber.findMany({ where: { organizationId: box.organizationId }, select: { id: true, name: true } }),
    ]);
    return res.json({ success: true, data: { ...mailboxView({ ...box, organization }, true), rules, waNumbers, retentionDays: EVENT_RETENTION_DAYS } } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

/** New settings or password (tested before saving), or pause/resume. */
router.patch('/mailboxes/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const box = await mailboxFor(req, req.params.id);
    if (!box) return bad(res, 'Mailbox not found', 404);
    const data: Record<string, unknown> = {};
    let restart = false;
    if (['host', 'port', 'secure', 'username', 'password'].some((k) => req.body?.[k] !== undefined)) {
      const current = { host: box.host, port: box.port, secure: box.secure, username: box.username, password: decrypt(box.passwordEnc) };
      const settings = settingsFrom(req.body, box.email, current);
      if (typeof settings === 'string') return bad(res, settings);
      await testLogin(settings);
      Object.assign(data, { host: settings.host, port: settings.port, secure: settings.secure, username: settings.username, passwordEnc: encrypt(settings.password), status: 'OK', lastError: null });
      restart = true;
    }
    if (req.body?.paused !== undefined) {
      data.status = req.body.paused ? 'PAUSED' : 'OK';
      if (!req.body.paused) data.lastError = null;
      restart = true;
    }
    await prisma.emailMailbox.update({ where: { id: box.id }, data });
    if (restart && !(await syncMailbox(box.id, true))) return bad(res, NO_BALANCE, 402);
    return res.json({ success: true } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

router.delete('/mailboxes/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const box = await mailboxFor(req, req.params.id);
    if (!box) return bad(res, 'Mailbox not found', 404);
    stop(box.id);
    await prisma.emailMailbox.delete({ where: { id: box.id } });
    return res.json({ success: true } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

/** A rule tried on the last 30 days of mail before it is saved. Nothing is stored. */
router.post('/mailboxes/:id/preview', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const box = await mailboxFor(req, req.params.id);
    if (!box) return bad(res, 'Mailbox not found', 404);
    const fields = validFields(req.body?.fields ?? []);
    if (typeof fields === 'string') return bad(res, fields);
    const rule = {
      fromContains: String(req.body?.fromContains ?? '').slice(0, 200),
      subjectContains: String(req.body?.subjectContains ?? '').slice(0, 200),
      bodyContains: String(req.body?.bodyContains ?? '').slice(0, 200),
      fields,
    };
    if (!rule.fromContains.trim() && !rule.subjectContains.trim()) return bad(res, 'Filter on the sender or the subject first');
    const settings = { host: box.host, port: box.port, secure: box.secure, username: box.username, password: decrypt(box.passwordEnc) };
    return res.json({ success: true, data: await previewRule(settings, rule) } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

// ── Rules ──

router.post('/mailboxes/:id/rules', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const box = await mailboxFor(req, req.params.id);
    if (!box) return bad(res, 'Mailbox not found', 404);
    const data = await ruleFrom(req.body, box.organizationId);
    const rule = await prisma.emailRule.create({ data: { ...(data as any), mailboxId: box.id, webhookSecret: randomBytes(24).toString('hex') } });
    // saved either way; a balance that does not cover today pauses the mailbox, said as a warning
    const watching = await syncMailbox(box.id);
    return res.status(201).json({ success: true, data: { ...rule, ...(!watching && { warning: NO_BALANCE }) } } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

router.patch('/rules/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rule = await ruleFor(req, req.params.id);
    if (!rule) return bad(res, 'Rule not found', 404);
    const data = await ruleFrom(req.body, rule.mailbox.organizationId, true);
    if (!(data.fromContains ?? rule.fromContains) && !(data.subjectContains ?? rule.subjectContains)) {
      return bad(res, 'Filter on the sender or the subject, so the rule does not take every email');
    }
    if (req.body?.newSecret) data.webhookSecret = randomBytes(24).toString('hex');
    const updated = await prisma.emailRule.update({ where: { id: rule.id }, data });
    const watching = await syncMailbox(rule.mailboxId);
    return res.json({ success: true, data: { ...updated, ...(!watching && { warning: NO_BALANCE }) } } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

router.delete('/rules/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rule = await ruleFor(req, req.params.id);
    if (!rule) return bad(res, 'Rule not found', 404);
    await prisma.emailRule.delete({ where: { id: rule.id } });
    await syncMailbox(rule.mailboxId);
    return res.json({ success: true } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

// ── Events ──

router.get('/mailboxes/:id/events', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const box = await mailboxFor(req, req.params.id);
    if (!box) return bad(res, 'Mailbox not found', 404);
    const { page, limit, skip, search } = paging(req);
    const where = {
      rule: { mailboxId: box.id },
      ...(search && { OR: [{ subject: { contains: search, mode: 'insensitive' as const } }, { from: { contains: search, mode: 'insensitive' as const } }] }),
    };
    const [rows, total] = await Promise.all([
      prisma.emailEvent.findMany({ where, include: { rule: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      prisma.emailEvent.count({ where }),
    ]);
    return res.json(paginated(rows, total, page, limit));
  } catch (error) {
    return fail(res, error);
  }
});

/** Send again: the webhook once more; a WhatsApp message already sent is not sent twice (the gateway's ref). */
router.post('/events/:id/replay', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ev = await prisma.emailEvent.findUnique({ where: { id: String(req.params.id) }, include: { rule: true } });
    if (!ev || !(await mailboxFor(req, ev.rule.mailboxId))) return bad(res, 'Event not found', 404);
    if (!ev.rule.webhookUrl && !(ev.rule.waNumberId && ev.rule.waTo)) return bad(res, 'The rule sends nowhere: add a webhook or WhatsApp first');
    await prisma.emailEvent.update({ where: { id: ev.id }, data: { status: 'PENDING', attempts: 0, webhookAt: null, nextAttemptAt: new Date(), error: null } });
    await deliver(ev.id);
    return res.json({ success: true, data: await prisma.emailEvent.findUnique({ where: { id: ev.id } }) } as ApiResponse);
  } catch (error) {
    return fail(res, error);
  }
});

export default router;
