import { Router, Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { readFile, realpath } from 'fs/promises';
import { join } from 'path';
import { ApiResponse } from '../types';
import { AuthenticatedRequest } from '../middleware/auth';

const run = promisify(execFile);

/**
 * Update Larika itself, from its own page (superadmin). The panel runs from
 * /opt/larika/current as larika.service (docs/production-setup.md §13); an
 * update is larika-upgrade.sh, started as a transient systemd unit so it
 * outlives the restart it causes. What it prints goes to shared/upgrade.log,
 * which this page follows — through the restart too.
 */
const router: Router = Router();

const BASE = process.env.LARIKA_BASE || '/opt/larika';
const REPO = join(BASE, 'repo');
const LOG = join(BASE, 'shared', 'upgrade.log');
const UNIT = 'larika-upgrade';
const BRANCH = 'main';

const git = (args: string[]) =>
  run('git', ['-C', REPO, ...args], { timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).then((r) => r.stdout.trim());

/** Installed the way larika-upgrade.sh lays it out — not a dev checkout, not a tenant app. */
const supported = () => existsSync(join(BASE, 'current')) && existsSync(join(REPO, '.git'));

/** The unit is there only while an update or rollback runs (--collect). */
const running = () =>
  run('systemctl', ['is-active', UNIT]).then(
    (r) => r.stdout.trim() !== 'inactive',
    () => false,
  );

/** releases/<sha> → its commit; releases/initial (the tree before the first upgrade) has none. */
async function commitOf(release: string | null) {
  const sha = release?.match(/^(?:releases\/)?([0-9a-f]{40})$/)?.[1];
  if (!sha) return release ? { sha: null, label: release.replace(/^releases\//, '') } : null;
  const [subject = '', date = ''] = (await git(['log', '-1', '--format=%s%n%cI', sha]).catch(() => '')).split('\n');
  return { sha, label: sha.slice(0, 7), subject, date };
}

router.get('/update', async (req: AuthenticatedRequest, res: Response) => {
  if (!supported()) {
    return res.json({ success: true, data: { supported: false } } as ApiResponse);
  }
  try {
    // ?fetch=1: ask GitHub what is new; otherwise what the last fetch saw
    if (req.query.fetch === '1') await git(['fetch', '--quiet', 'origin', BRANCH]);
    const live = (await realpath(join(BASE, 'current'))).slice(BASE.length + 1);
    const previous = (await readFile(join(BASE, 'shared', 'previous'), 'utf8').catch(() => '')).trim() || null;
    const current = await commitOf(live);
    const target = `origin/${BRANCH}`;
    const latest = await git(['rev-parse', target]).catch(() => null);
    const pending = latest && latest !== current?.sha
      ? (await git(['log', '--format=%H%x1f%s%x1f%an%x1f%cI', '-n', '50', current?.sha ? `${current.sha}..${target}` : target]).catch(() => ''))
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [sha, subject, author, date] = line.split('\x1f');
            return { sha, subject, author, date };
          })
      : [];
    const log = await readFile(LOG, 'utf8').catch(() => '');
    return res.json({
      success: true,
      data: {
        supported: true,
        branch: BRANCH,
        current,
        previous: await commitOf(previous),
        latest,
        pending,
        running: await running(),
        log: log.slice(-50_000),
      },
    } as ApiResponse);
  } catch (error: any) {
    return res.status(500).json({ success: false, error: String(error?.stderr || error?.message || error).slice(0, 500) } as ApiResponse);
  }
});

/**
 * Start an update (the newest `main`) or a rollback (the release before). The
 * repo is brought to origin/main first, so the script that runs is the new
 * one. It builds beside the live release, waits for running deploys, then
 * restarts the panel — this request is answered long before that.
 */
router.post('/update', async (req: AuthenticatedRequest, res: Response) => {
  if (!supported()) return res.status(400).json({ success: false, error: 'This panel is not installed with larika-upgrade.sh' } as ApiResponse);
  const rollback = req.body?.action === 'rollback';
  if (await running()) return res.status(409).json({ success: false, error: 'An update is already running' } as ApiResponse);
  try {
    if (!rollback) {
      await git(['fetch', '--quiet', 'origin', BRANCH]);
      await git(['reset', '--quiet', '--hard', `origin/${BRANCH}`]);
    }
    await run(
      'sudo',
      [
        '-n', 'systemd-run', `--unit=${UNIT}`, '--collect', '--quiet',
        `--property=StandardOutput=truncate:${LOG}`, `--property=StandardError=append:${LOG}`,
        '/bin/bash', join(REPO, 'larika-upgrade.sh'), ...(rollback ? ['--rollback'] : ['--branch', BRANCH]),
      ],
      { timeout: 30_000 },
    );
    console.log(`🔄 ${rollback ? 'Rollback' : 'Update'} of Larika started by ${req.user!.email ?? req.user!.userId}`);
    return res.status(202).json({ success: true, message: rollback ? 'Rollback started' : 'Update started' } as ApiResponse);
  } catch (error: any) {
    return res.status(500).json({ success: false, error: String(error?.stderr || error?.message || error).slice(0, 500) } as ApiResponse);
  }
});

export default router;
