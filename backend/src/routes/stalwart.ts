import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { ApiResponse } from '../types';
import { prisma } from '../lib/prisma';
import { canEncrypt, encrypt } from '../lib/secretBox';
import { getStalwartValue, setStalwartValue, STALWART_ALERT_THRESHOLD, STALWART_LOG_DIR } from '../services/integrationConfigService';
import { syncNodeIpAllowlists } from '../lib/servers';
import { cancelQueue, checkStalwart, getQueue, lockAccount, logSenders, StalwartError } from '../services/stalwartService';

// Mounted superadmin-only in index.ts: the Stalwart mail server — who fills its
// outgoing queue, cancelling that mail, locking the account, its log per day.
const router: Router = Router();

async function status() {
  const [baseUrl, username, password, serverId, logDir, alertThreshold] = await Promise.all(
    (['baseUrl', 'username', 'password', 'serverId', 'logDir', 'alertThreshold'] as const).map(getStalwartValue),
  );
  const server = serverId ? await prisma.server.findUnique({ where: { id: serverId }, select: { id: true, name: true } }) : null;
  return {
    baseUrl: baseUrl ?? '',
    username: username ?? '',
    passwordSet: !!password,
    server,
    logDir: logDir || STALWART_LOG_DIR,
    alertThreshold: Number(alertThreshold) || STALWART_ALERT_THRESHOLD,
  };
}

const fail = (res: Response, error: any, what: string) => {
  if (error instanceof StalwartError) return res.status(502).json({ success: false, error: error.message } as ApiResponse);
  console.error(`Stalwart: ${what}:`, error);
  return res.status(500).json({ success: false, error: error?.message || `Failed to ${what}` } as ApiResponse);
};

router.get('/config', async (_req, res: Response) => {
  try {
    const s = await status();
    return res.json({ success: true, data: { ...s, error: s.passwordSet ? await checkStalwart() : null } } as ApiResponse);
  } catch (error) {
    return fail(res, error, 'read the Stalwart config');
  }
});

router.put('/config', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { baseUrl, username, password, serverId, logDir, alertThreshold } = req.body as Record<string, string | number | undefined>;
    if (baseUrl !== undefined) {
      const url = String(baseUrl).trim().replace(/\/+$/, '');
      if (url && !/^https?:\/\/[^\s/]+/.test(url)) return res.status(400).json({ success: false, error: 'The URL looks like https://mail.example.com' } as ApiResponse);
      await setStalwartValue('baseUrl', url);
    }
    if (username !== undefined) await setStalwartValue('username', String(username).trim());
    // blank keeps the stored password
    if (typeof password === 'string' && password) {
      if (!canEncrypt()) return res.status(500).json({ success: false, error: 'CB_SECRET_KEY is not set, so the password cannot be stored encrypted' } as ApiResponse);
      await setStalwartValue('password', encrypt(password));
    }
    if (serverId !== undefined) {
      if (serverId && !(await prisma.server.findUnique({ where: { id: String(serverId) } }))) return res.status(404).json({ success: false, error: 'Node not found' } as ApiResponse);
      await setStalwartValue('serverId', String(serverId ?? ''));
    }
    if (logDir !== undefined) {
      const dir = String(logDir).trim().replace(/\/+$/, '');
      if (dir && !/^\/[\w./-]+$/.test(dir)) return res.status(400).json({ success: false, error: 'The log folder is an absolute path, like /var/log/stalwart' } as ApiResponse);
      await setStalwartValue('logDir', dir);
    }
    if (alertThreshold !== undefined) {
      const n = Math.floor(Number(alertThreshold));
      if (!(n >= 1)) return res.status(400).json({ success: false, error: 'The alert threshold is a number of messages, 1 or more' } as ApiResponse);
      await setStalwartValue('alertThreshold', String(n));
    }
    const s = await status();
    const error = s.passwordSet ? await checkStalwart() : null;
    // connected: our nodes go on its allowed-IP list (probing them takes a while, so not awaited)
    if (s.passwordSet && !error) void syncNodeIpAllowlists();
    return res.json({ success: true, data: { ...s, error } } as ApiResponse);
  } catch (error) {
    return fail(res, error, 'save the Stalwart config');
  }
});

/** The outgoing queue by sender, most messages first. */
router.get('/queue', async (_req, res: Response) => {
  try {
    return res.json({ success: true, data: await getQueue() } as ApiResponse);
  } catch (error) {
    return fail(res, error, 'read the queue');
  }
});

router.post('/queue/cancel', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const sender = String(req.body?.sender ?? '').trim();
    if (!sender) return res.status(400).json({ success: false, error: 'Which sender?' } as ApiResponse);
    const cancelled = await cancelQueue(sender);
    console.log(`Stalwart: ${req.user!.email} cancelled ${cancelled} queued message(s) from ${sender}`);
    return res.json({ success: true, data: { cancelled } } as ApiResponse);
  } catch (error) {
    return fail(res, error, 'cancel the queue');
  }
});

router.post('/accounts/lock', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const locked = await lockAccount(String(req.body?.email ?? ''));
    console.log(`Stalwart: ${req.user!.email} locked ${locked.email}`);
    return res.json({ success: true, data: locked } as ApiResponse);
  } catch (error) {
    return fail(res, error, 'lock the account');
  }
});

/** One day's senders from the log on the node. ?day=YYYY-MM-DD */
router.get('/log-senders', async (req, res: Response) => {
  try {
    return res.json({ success: true, data: await logSenders(String(req.query.day ?? '')) } as ApiResponse);
  } catch (error) {
    return fail(res, error, 'read the log');
  }
});

export default router;
