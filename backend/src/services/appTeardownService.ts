import path from 'path';
import type { Application } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { rm } from '../lib/remoteFs';
import { removeCaddySite } from './caddyService';
import { removeAppHostname } from './appDnsService';
import { APPS_ROOT_DIR, PANEL_HOST, deletePm2Process, listListeningPorts } from './appSyncService';
import { HOME_ROOT } from '../lib/appPaths';
import { exec } from '../lib/runner';

/**
 * Removing an imported app from its server — the pieces someone set up by
 * hand. Nothing here runs on its own: the user ticks each step in the delete
 * dialog, and only those run. Apps the panel deployed (no runtime) are torn
 * down by the delete route itself; this is only for the imported ones.
 *
 * Order matters: stop the process before its route goes (no window where the
 * route points at nothing but the process still writes), and delete files last.
 */

export const TEARDOWN_ORDER = ['process', 'route', 'dns', 'files'] as const;
export type TeardownStepId = (typeof TEARDOWN_ORDER)[number];

/**
 * Text for the dialog: the English sentence is the frontend's i18n key, and
 * `params` fill its {placeholders} — so the page can translate it.
 */
export type Msg = { text: string; params?: Record<string, string | number> };
const msg = (text: string, params?: Msg['params']): Msg => (params ? { text, params } : { text });
/** A Msg as plain English, for API errors and logs. */
export const format = ({ text, params = {} }: Msg) => text.replace(/\{(\w+)\}/g, (m, key) => (key in params ? String(params[key]) : m));

export type TeardownStep = {
  id: TeardownStepId;
  /** the exact command or path, shown verbatim — never translated */
  command?: string | undefined;
  /** what is removed, when there is no command to show */
  detail?: Msg | undefined;
  /** why it cannot run — and so the app cannot be deleted until it is sorted out */
  blocked?: Msg | undefined;
  /** already true on the server, nothing to run (the proxied port has no listener) */
  satisfied?: Msg | undefined;
};

const cleanPath = (dir: string) => path.posix.normalize(dir).replace(/\/+$/, '') || '/';

/**
 * Where an app folder may be deleted from: strictly inside one of these, never
 * one of them itself. An allowlist, not a denylist — a denylist has to think of
 * /etc/caddy, /var/lib/mysql and every other system folder, and missing one is
 * an `rm -rf` of it (as root, when the node is logged into as root).
 * Under the home root the app must be inside a user's home, not the home itself.
 */
const HOME = cleanPath(HOME_ROOT);
const ALLOWED_ROOTS = [...new Set(['/root', '/var/www', '/srv', '/opt', cleanPath(APPS_ROOT_DIR)])];

/**
 * Why `dir` must not be `rm -rf`ed, or null when it may. Pure.
 * `others`: every other app's folder on the same server — a folder inside,
 * above or equal to one of those belongs (partly) to someone else.
 */
export function folderRisk(dir: string | null | undefined, others: string[]): Msg | null {
  if (!dir) return msg('No folder was detected for this app');
  if (!dir.startsWith('/') || /[\0\r\n]/.test(dir) || dir.split('/').includes('..')) {
    return msg('{dir} is not a plain absolute path', { dir });
  }

  const clean = cleanPath(dir);
  const segments = clean.split('/').filter(Boolean);
  // .ssh, .config, .pm2 … — never an app, often what keeps the box reachable
  if (segments.some((segment) => segment.startsWith('.'))) return msg('{dir} is a hidden folder', { dir: clean });
  // the panel's own org homes: those apps are torn down by the panel, not here
  if (clean.startsWith(`${HOME}/cb-`)) return msg('{dir} is managed by the panel', { dir: clean });

  const underHome = clean.startsWith(HOME + '/') && clean.split('/').length - HOME.split('/').length >= 2;
  const underRoot = ALLOWED_ROOTS.some((root) => clean.startsWith(root + '/'));
  // a root nested in another (/var/www/html in /var/www) is still a root: every app lives in it
  const isRoot = clean === HOME || ALLOWED_ROOTS.includes(clean);
  if (isRoot || (!underHome && !underRoot)) return msg('{dir} is a system or home folder', { dir: clean });

  const shared = others
    .map((other) => path.posix.normalize(other).replace(/\/+$/, ''))
    .find((other) => other === clean || other.startsWith(clean + '/') || clean.startsWith(other + '/'));
  return shared ? msg('{dir} belongs to another app', { dir: shared }) : null;
}

async function serverOf(app: Application) {
  return app.serverId ? prisma.server.findUnique({ where: { id: app.serverId } }) : null;
}

/** Every other app's folder on the server. */
const otherFolders = async (serverId: string, appId: string) =>
  (
    await prisma.application.findMany({
      where: { serverId, id: { not: appId }, rootPath: { not: null } },
      select: { rootPath: true },
    })
  ).map((other) => other.rootPath!);

/**
 * `rm -rf` of the app's folder, checked again on the box itself right before it
 * runs. The row's path passed folderRisk, but the disk can disagree: a symlink
 * anywhere along it (/home/deploy/app → /) makes the folder that would really go
 * something else. So: resolve the real path, require a directory, and run the
 * same rules on what it resolves to — and on the other apps' resolved folders,
 * and the SSH user's own home. Only the resolved path is removed.
 */
async function removeFolder(server: NonNullable<Awaited<ReturnType<typeof serverOf>>>, app: Application): Promise<void> {
  const others = await otherFolders(server.id, app.id);
  // line 1: the real directory (empty when it is not one), line 2: $HOME, then each other folder resolved
  const script = [
    'if [ -d "$1" ]; then realpath -e -- "$1"; else echo; fi',
    'printf "%s\\n" "$HOME"',
    'shift',
    'for d; do realpath -m -- "$d"; done',
  ].join('; ');
  const { stdout } = await exec(server, ['sh', '-c', script, 'sh', cleanPath(app.rootPath!), ...others], { timeout: 15_000 });
  // not trimmed: "/srv/app " and "/srv/app" are different folders
  const [real = '', home = '', ...resolvedOthers] = stdout.split('\n').map((line) => line.replace(/\r$/, ''));
  if (!real) throw new Error(`${app.rootPath} is not a folder on the server`);

  const risk =
    folderRisk(real, [...others, ...resolvedOthers.filter(Boolean)]) ??
    (home && (real === cleanPath(home) || home.startsWith(real + '/')) ? msg("{dir} is the SSH user's home", { dir: real }) : null);
  if (risk) throw new Error(real === cleanPath(app.rootPath!) ? format(risk) : `${app.rootPath} resolves to ${real}: ${format(risk)}`);

  // as the SSH user, not root: a folder that user cannot delete is reported, not forced
  await rm(server, real, { recursive: true });
}

/** What can be removed for this app, and what cannot and why. Empty for panel-deployed apps. */
export async function teardownPlan(app: Application): Promise<TeardownStep[]> {
  if (!app.runtime) return [];

  const server = await serverOf(app);
  const noServer = server ? undefined : msg('Not linked to a server — sync the apps again first');
  // the panel's own site shows up in scans; removing it would take this panel down
  const isPanel = PANEL_HOST !== '' && app.domain.toLowerCase() === PANEL_HOST ? msg('This is the panel itself') : undefined;
  const placeholder = app.domain.endsWith('.pm2.local');
  const steps: TeardownStep[] = [];

  if (app.runtime === 'PM2' && app.processName) {
    steps.push({ id: 'process', command: `pm2 delete ${app.processName} && pm2 save`, blocked: isPanel ?? noServer });
  } else if (app.runtime === 'CADDY_PROXY' && app.port) {
    // not pm2's, so we cannot stop it — but we can see whether it is already gone
    const listening = server ? await listListeningPorts(server) : new Map();
    const port = app.port;
    steps.push({
      id: 'process',
      detail: msg('Whatever listens on port {port}', { port }),
      ...(noServer
        ? { blocked: noServer }
        : listening.size === 0
          ? { blocked: msg('Could not check whether port {port} is in use', { port }) }
          : listening.has(port)
            ? { blocked: msg('Something still listens on port {port}. It was not started by pm2 — stop it on the server first', { port }) }
            : { satisfied: msg('Nothing listens on port {port} any more', { port }) }),
    });
  }

  if (!placeholder) {
    steps.push({ id: 'route', detail: msg('Caddy route for {domain}', { domain: app.domain }), blocked: isPanel ?? noServer });
    if (app.domainId) {
      steps.push({
        id: 'dns',
        detail: msg('DNS record {domain} → this server (Cloudflare, only if it points here)', { domain: app.domain }),
        blocked: isPanel,
      });
    }
  }

  // a proxied process may still be running from its folder; do not pull it out
  // from under it. No folder detected: nothing known to delete.
  if (app.runtime !== 'CADDY_PROXY' && app.rootPath) {
    const others = server ? await otherFolders(server.id, app.id) : [];
    const risk = folderRisk(app.rootPath, others);
    steps.push({
      id: 'files',
      ...(risk ? { detail: msg('The app folder') } : { command: `rm -rf ${cleanPath(app.rootPath)}` }),
      blocked: isPanel ?? noServer ?? risk ?? undefined,
    });
  }

  return steps;
}

/** Steps that stop the delete, as one English sentence; null when it can go ahead. */
export const blockedBy = (plan: TeardownStep[]): string | null => {
  const blocked = plan.filter((step) => step.blocked);
  return blocked.length ? blocked.map((step) => `${step.command ?? format(step.detail!)}: ${format(step.blocked!)}`).join('; ') : null;
};

export type TeardownResult = { done: TeardownStepId[]; failed?: { step: TeardownStepId; error: string } };

/**
 * All or nothing: every step in the plan runs, in TEARDOWN_ORDER. A blocked step
 * refuses the whole thing before anything runs; after that the first failure
 * stops the rest, and the caller keeps the row so the user sees what is left.
 */
export async function teardownApp(app: Application): Promise<TeardownResult> {
  const plan = await teardownPlan(app);
  const blocked = blockedBy(plan);
  if (blocked) throw new Error(blocked);

  const steps = TEARDOWN_ORDER.filter((id) => plan.some((step) => step.id === id && !step.satisfied));
  const server = await serverOf(app);
  const done: TeardownStepId[] = [];

  for (const id of steps) {
    try {
      if (id === 'process') await deletePm2Process(server!, app.processName!);
      if (id === 'route') await removeCaddySite(server!, app.domain);
      if (id === 'dns') await removeAppHostname(app);
      if (id === 'files') await removeFolder(server!, app);
      done.push(id);
    } catch (error: any) {
      return { done, failed: { step: id, error: String(error?.stderr || error?.message || error).trim() } };
    }
  }

  return { done };
}
