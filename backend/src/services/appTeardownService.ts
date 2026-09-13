import path from 'path';
import type { Application } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { rm } from '../lib/remoteFs';
import { removeCaddySite } from './caddyService';
import { removeAppHostname } from './appDnsService';
import { APPS_ROOT_DIR, PANEL_HOST, deletePm2Process } from './appSyncService';
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
  /** why it cannot be offered; the checkbox is disabled */
  blocked?: Msg | undefined;
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
  if (!underHome && !underRoot) return msg('{dir} is a system or home folder', { dir: clean });

  const shared = others
    .map((other) => path.posix.normalize(other).replace(/\/+$/, ''))
    .find((other) => other === clean || other.startsWith(clean + '/') || clean.startsWith(other + '/'));
  return shared ? msg('{dir} belongs to another app', { dir: shared }) : null;
}

async function serverOf(app: Application) {
  return app.serverId ? prisma.server.findUnique({ where: { id: app.serverId } }) : null;
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
  } else if (app.runtime === 'CADDY_PROXY') {
    steps.push({
      id: 'process',
      detail: app.port ? msg('Whatever listens on port {port}', { port: app.port }) : msg('The process behind the proxy'),
      blocked: msg('Not started by pm2, so we do not know how to stop it — stop it on the server yourself'),
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

  // a proxied process may still be running from its folder; do not pull it out from under it
  if (app.runtime !== 'CADDY_PROXY') {
    const others = server
      ? (
          await prisma.application.findMany({
            where: { serverId: server.id, id: { not: app.id }, rootPath: { not: null } },
            select: { rootPath: true },
          })
        ).map((other) => other.rootPath!)
      : [];
    steps.push({
      id: 'files',
      ...(app.rootPath ? { command: `rm -rf ${app.rootPath}` } : { detail: msg('The app folder') }),
      blocked: isPanel ?? noServer ?? folderRisk(app.rootPath, others) ?? undefined,
    });
  }

  return steps;
}

export type TeardownResult = { done: TeardownStepId[]; failed?: { step: TeardownStepId; error: string } };

/**
 * Run the ticked steps, in TEARDOWN_ORDER. Every requested step is checked
 * against the plan before anything runs; after that the first failure stops the
 * rest, so the caller keeps the row and the user can see what is left.
 */
export async function teardownApp(app: Application, requested: string[]): Promise<TeardownResult> {
  const plan = await teardownPlan(app);
  const steps = TEARDOWN_ORDER.filter((id) => requested.includes(id));

  for (const id of requested) {
    const step = plan.find((s) => s.id === id);
    if (!step) throw new Error(`"${id}" is not something that can be removed for this app`);
    if (step.blocked) throw new Error(`Cannot remove ${step.command ?? format(step.detail!)}: ${format(step.blocked)}`);
  }

  const server = await serverOf(app);
  const done: TeardownStepId[] = [];

  for (const id of steps) {
    try {
      if (id === 'process') await deletePm2Process(server!, app.processName!);
      if (id === 'route') await removeCaddySite(server!, app.domain);
      if (id === 'dns') await removeAppHostname(app);
      // as the SSH user, not root: a folder that user cannot delete is reported, not forced
      if (id === 'files') await rm(server!, app.rootPath!, { recursive: true });
      done.push(id);
    } catch (error: any) {
      return { done, failed: { step: id, error: String(error?.stderr || error?.message || error).trim() } };
    }
  }

  return { done };
}
