import { listCaddySites, CaddySite } from './appSyncService';
import {
  configureCaddyForRuntimeApplication,
  configureCaddyForPhpApplication,
  configureCaddyForFiles,
  listCaddyRouteHosts,
} from './caddyService';

/**
 * Moving the sites in /etc/caddy/sites from files to the admin API.
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
export async function adoptCaddySites({ apply = false }: { apply?: boolean } = {}): Promise<{
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
          await configureCaddyForRuntimeApplication(domain, target.port);
        } else if (target.kind === 'php') {
          await configureCaddyForPhpApplication(domain, target.root, target.socket);
        } else {
          await configureCaddyForFiles(domain, target.root);
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

/**
 * Caddy holds the API config in memory only: `systemctl reload caddy` re-reads
 * the Caddyfile and drops every route the platform pushed. The backend re-applies
 * at boot, but a reload while it is running would otherwise go unnoticed until
 * someone restarted it — so check, and heal what is missing.
 */
export async function healCaddyRoutes(): Promise<string> {
  if (!process.env.CADDY_API_URL) return 'skipped — CADDY_API_URL is not set';

  const live = await listCaddyRouteHosts();
  if (live === null) return 'skipped — Caddy did not answer';

  // Deferred so the watchdog does not drag the deployment service into every
  // module that imports this one.
  const { DeploymentService } = await import('./deployment');
  const deployment = new DeploymentService();

  const expected = await deployment.expectedCaddyHosts();
  const missing = expected.filter((host) => !live.includes(host));
  const fileSites = (await listCaddySites()).flatMap((site) => site.domains);
  const missingFiles = fileSites.filter((host) => !live.includes(host));

  if (missing.length === 0 && missingFiles.length === 0) {
    return `${live.length} routes live, nothing missing`;
  }

  const { applied, failed } = await deployment.reapplyCaddyRoutes();
  const adopted = missingFiles.length > 0 ? (await adoptCaddySites({ apply: true })).applied : 0;

  return `re-applied ${applied} route(s) (${failed} failed), re-adopted ${adopted} file site(s) — was missing ${[
    ...missing,
    ...missingFiles,
  ]
    .slice(0, 5)
    .join(', ')}`;
}
