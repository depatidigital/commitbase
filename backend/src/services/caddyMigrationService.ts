import { listCaddySites, CaddySite } from './appSyncService';
import type { SshTarget } from '../lib/runner';
import {
  configureCaddyForRuntimeApplication,
  configureCaddyForPhpApplication,
  configureCaddyForFiles,
} from './caddyService';

/**
 * Moving the sites in /etc/caddy/sites from files to the admin API.
 *
 * Once an install has migrated, this finds nothing and does nothing —
 * `caddySnapshotService` is what keeps API-only routes alive from then on.
 *
 * The platform's own apps have always been configured over the API; sites that
 * predate CommitBase still live in `.caddy` files imported by the Caddyfile.
 * This reads those files and pushes the same routes through the API, so there
 * is one source of truth instead of two.
 *
 * The files are never deleted — after adopting, remove the
 * `import /etc/caddy/sites/*.caddy` line from the Caddyfile so a reload does
 * not load them a second time. They stay on disk as the record of how each
 * imported site is configured, which is what `adoptCaddySites` reads on every
 * later run (a watchdog included).
 */

export type AdoptedSite = {
  domain: string;
  kind: 'proxy' | 'php' | 'files';
  detail: string;
  configPath: string;
  /** false when the site was understood but nothing was pushed (dry run) */
  applied: boolean;
  error?: string;
};

/** What a parsed site block should become as an API route. */
function targetFor(site: CaddySite):
  | { kind: 'proxy'; port: number }
  | { kind: 'php'; root: string; socket: string }
  | { kind: 'files'; root: string }
  | null {
  if (site.port) return { kind: 'proxy', port: site.port };
  if (site.php && site.rootPath && site.socket) {
    return { kind: 'php', root: site.rootPath, socket: site.socket };
  }
  if (site.rootPath) return { kind: 'files', root: site.rootPath };
  return null;
}

/**
 * Push every site file through the admin API. Idempotent — a route that is
 * already there is simply written again.
 *
 * `apply` defaults to false so the first run is a dry run: it reports what it
 * understood and what it could not, and changes nothing.
 */
export async function adoptCaddySites(
  node: SshTarget,
  { apply = false }: { apply?: boolean } = {},
): Promise<{
  sites: AdoptedSite[];
  applied: number;
  skipped: number;
}> {
  const sites = await listCaddySites();
  const results: AdoptedSite[] = [];

  for (const site of sites) {
    const target = targetFor(site);

    for (const domain of site.domains) {
      if (!target) {
        results.push({
          domain,
          kind: 'files',
          detail: 'Could not tell what this site serves — configure it by hand',
          configPath: site.configPath,
          applied: false,
          error: 'unrecognised site block',
        });
        continue;
      }

      const detail =
        target.kind === 'proxy'
          ? `reverse proxy to localhost:${target.port}`
          : target.kind === 'php'
            ? `PHP from ${target.root} via ${target.socket}`
            : `files from ${target.root}`;

      if (!apply) {
        results.push({ domain, kind: target.kind, detail, configPath: site.configPath, applied: false });
        continue;
      }

      try {
        if (target.kind === 'proxy') {
          await configureCaddyForRuntimeApplication(node, domain, target.port);
        } else if (target.kind === 'php') {
          await configureCaddyForPhpApplication(node, domain, target.root, target.socket);
        } else {
          await configureCaddyForFiles(node, domain, target.root);
        }
        results.push({ domain, kind: target.kind, detail, configPath: site.configPath, applied: true });
      } catch (error: any) {
        results.push({
          domain,
          kind: target.kind,
          detail,
          configPath: site.configPath,
          applied: false,
          error: String(error?.message ?? 'Failed to push the route').slice(0, 200),
        });
      }
    }
  }

  return {
    sites: results,
    applied: results.filter((site) => site.applied).length,
    skipped: results.filter((site) => !site.applied).length,
  };
}
