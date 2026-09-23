import { prisma } from '../lib/prisma';
import type { SshTarget } from '../lib/runner';
import { buildRoute, removeCaddySite, setHostRoute, type ServeTuning, type Target } from './caddyService';

/**
 * One Caddy route per hostname, composed from every app bound to it
 * (AppDomain host + path): an API under `/api/*`, the front end for the rest.
 * Each app says what Caddy sends its requests to (`Application.serve`); the
 * paths decide the order — the longest prefix first, the whole name last —
 * so there is no hand-kept order to get wrong.
 */

/** What Caddy sends an app's requests to. */
export type Serve =
  | ({ kind: 'proxy'; port: number } & ServeTuning)
  | { kind: 'files'; root: string; spa?: boolean | undefined }
  | ({ kind: 'php'; root: string; socket: string } & ServeTuning)
  | { kind: 'bucket'; origin: string }
  /** nothing deployed yet: the "ready, waiting for its first deploy" page */
  | { kind: 'placeholder' };

/** An app on a hostname: its path ("" = the rest of the name), whether the prefix is dropped, and its serve. */
export type Binding = { path: string; stripPrefix: boolean; serve: Serve };

/** A stored `serve`, checked — a bad or missing one is null. Pure. */
export function readServe(raw: unknown): Serve | null {
  const s = raw as any;
  if (!s || typeof s !== 'object') return null;
  if (s.kind === 'proxy' && Number.isInteger(s.port) && s.port > 0 && s.port < 65536) return { kind: 'proxy', port: s.port, ...readTuning(s) };
  if (s.kind === 'files' && typeof s.root === 'string' && s.root.startsWith('/')) return { kind: 'files', root: s.root, spa: s.spa === true };
  if (s.kind === 'php' && typeof s.root === 'string' && typeof s.socket === 'string') return { kind: 'php', root: s.root, socket: s.socket, ...readTuning(s) };
  if (s.kind === 'bucket' && typeof s.origin === 'string' && s.origin) return { kind: 'bucket', origin: s.origin };
  if (s.kind === 'placeholder') return { kind: 'placeholder' };
  return null;
}

/**
 * The kept-behaviour fields of a stored serve, checked. Absent everywhere but
 * on a site adopted from another web server, so anything malformed is simply
 * dropped rather than refusing the whole serve. Pure.
 */
export function readTuning(raw: any): ServeTuning {
  const out: ServeTuning = {};
  if (Number.isInteger(raw?.maxBodyBytes) && raw.maxBodyBytes > 0) out.maxBodyBytes = raw.maxBodyBytes;
  if (typeof raw?.readTimeout === 'string' && /^\d+(ms|s|m|h)?$/.test(raw.readTimeout)) out.readTimeout = raw.readTimeout;
  if (raw?.streaming === true) out.streaming = true;
  return out;
}

/** The literal part of a path pattern — `/api/*` → `/api`, `/ws*` → `/ws`. Pure. */
export const pathPrefix = (pattern: string) => pattern.replace(/\*+$/, '').replace(/\/+$/, '');

/**
 * The order Caddy should try a hostname's bindings in: the longest literal
 * prefix first (`/api/v2/*` before `/api/*`), the whole name ("") last. Pure.
 */
export function byPrecedence(a: { path: string }, b: { path: string }): number {
  if (!a.path !== !b.path) return a.path ? -1 : 1;
  return pathPrefix(b.path).length - pathPrefix(a.path).length || a.path.localeCompare(b.path);
}

/** The route handle one serve is — the same a single-app route has always had. Pure. */
export function serveHandle(serve: Serve): any[] {
  const target: Target =
    serve.kind === 'proxy'
      ? { type: 'runtime', upstreamPort: serve.port, ...readTuning(serve) }
      : serve.kind === 'files'
        ? { type: 'split', parts: [{ path: null, root: serve.root, spa: serve.spa }] }
        : serve.kind === 'php'
          ? { type: 'php', root: serve.root, socket: serve.socket, ...readTuning(serve) }
          : serve.kind === 'bucket'
            ? { type: 'bucket', origin: serve.origin }
            : { type: 'placeholder' };
  return buildRoute('_', target).handle;
}

/**
 * A hostname's route handle from its bindings. One binding on the whole name
 * is just that app's handle — the route every single-app hostname already has.
 * Several: a subroute, one entry per path in precedence order; a stripped
 * prefix is rewritten away first (Caddy's handle_path). Pure.
 */
export function composeHostHandle(bindings: Binding[]): any[] {
  const sorted = [...bindings].sort(byPrecedence);
  if (sorted.length === 1 && !sorted[0]!.path) return serveHandle(sorted[0]!.serve);
  return [
    {
      handler: 'subroute',
      routes: sorted.map((binding) => ({
        ...(binding.path && { match: [{ path: [binding.path] }] }),
        handle: [
          ...(binding.path && binding.stripPrefix ? [{ handler: 'rewrite', strip_path_prefix: pathPrefix(binding.path) }] : []),
          ...serveHandle(binding.serve),
        ],
        terminal: true,
      })),
    },
  ];
}

export class HostRouteError extends Error {}

/**
 * Write each hostname's route again from the apps bound to it now. A name no
 * app is bound to any more loses its route. A name held by one app whose
 * serve is not known (an imported site nobody changed) is left exactly as it
 * is on the server — its hand-written route is never rebuilt for nothing.
 */
export async function recomposeHosts(node: SshTarget, hosts: string[], { without }: { without?: string } = {}): Promise<void> {
  for (const host of [...new Set(hosts)]) {
    const bound = await prisma.appDomain.findMany({
      // `without`: as if that app were gone already — its delete removes the rows after
      where: { host, ...(without && { applicationId: { not: without } }) },
      select: { path: true, stripPrefix: true, application: { select: { name: true, serve: true, runtime: true } } },
    });
    if (bound.length === 0) {
      await removeCaddySite(node, host);
      continue;
    }
    // A panel app not deployed yet has nothing to route: its hosts are set up
    // before its first deploy, which routes them (serveApp). Left out until then.
    const rows = bound.filter((row) => readServe(row.application.serve) || row.application.runtime);
    if (rows.length === 0) continue;
    const unknown = rows.filter((row) => !readServe(row.application.serve));
    if (unknown.length) {
      if (rows.length === 1) continue;
      throw new HostRouteError(
        `${host} cannot be routed: the panel does not know what ${unknown.map((row) => row.application.name).join(', ')} is served by — sync the apps first`,
      );
    }
    await setHostRoute(
      node,
      host,
      composeHostHandle(rows.map((row) => ({ path: row.path, stripPrefix: row.stripPrefix, serve: readServe(row.application.serve)! }))),
    );
  }
}

/** Say what an app is served by, then route its hostnames again with it. */
export async function serveApp(node: SshTarget, applicationId: string, serve: Serve): Promise<void> {
  await prisma.application.update({ where: { id: applicationId }, data: { serve } });
  const rows = await prisma.appDomain.findMany({ where: { applicationId }, select: { host: true }, distinct: ['host'] });
  await recomposeHosts(node, rows.map((row) => row.host));
}

/**
 * A static site's serve: its files in R2 (the object storage set in the admin
 * settings); nothing published yet: the placeholder page.
 */
export async function serveStatic(node: SshTarget, applicationId: string, origin: string | null | undefined): Promise<void> {
  await serveApp(node, applicationId, origin ? { kind: 'bucket', origin } : { kind: 'placeholder' });
}

/** Hostnames no app but `applicationId` is bound to — the ones whose DNS record may go with it. */
export async function hostsOnlyOf(applicationId: string, hosts: string[]): Promise<string[]> {
  const shared = await prisma.appDomain.findMany({
    where: { host: { in: hosts }, applicationId: { not: applicationId } },
    select: { host: true },
    distinct: ['host'],
  });
  const taken = new Set(shared.map((row) => row.host));
  return hosts.filter((host) => !taken.has(host));
}

/**
 * A binding's path as asked for: "" (or "/") for the whole name, else a Caddy
 * prefix pattern — `/api/*`, `/ws*`, `/pos.apk`. null when it is not one. Pure.
 */
export function normalizeBindingPath(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  if (value === '' || value === '/' || value === '/*') return '';
  return /^\/[A-Za-z0-9._~\-/]*\*?$/.test(value) && !value.includes('..') && !value.includes('//') ? value : null;
}
