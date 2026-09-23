import { prisma } from '../lib/prisma';
import type { SshTarget } from '../lib/runner';
import { createApplicationWithSource } from '../lib/sources';
import { zonesFor } from '../lib/appDomains';
import { sitesOf } from '../lib/nginxConfig';
import { allRoutesOf, getCaddyConfig } from './caddyService';
import { readNginxFiles } from './nginxMigrateService';
import { classifyRoute, isNotAnApp, listDockerContainers, routeHosts, routeParts, type DockerContainer } from './appSyncService';

/**
 * Docker containers already running on a node, and adopting them as apps.
 *
 * Adopting is bookkeeping, like every other sync: the panel gets a row with the
 * container's published port as its upstream, and the hostnames whatever web
 * server fronts it (nginx or Caddy) already answers on. The container itself is
 * never started, stopped or rebuilt from here — docker keeps owning it.
 */

/** One published port, and who sends traffic to it. */
export type DockerPortMap = {
  port: number;
  nginxHosts: string[];
  caddyHosts: string[];
  /** the panel app already on this port of this node */
  app: { id: string; name: string; runtime: string | null } | null;
};

export type DockerContainerView = DockerContainer & { maps: DockerPortMap[] };

const LOCAL = /^(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)$/;

/** port → hostnames, from Caddy's live routes. Pure. */
export function caddyHostsByPort(config: any): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const add = (port: number, hosts: string[]) => out.set(port, [...new Set([...(out.get(port) ?? []), ...hosts])]);
  for (const route of allRoutesOf(config)) {
    const hosts = routeHosts(route).filter((host) => !isNotAnApp(host));
    const parts = routeParts(route);
    if (parts) {
      for (const part of parts) {
        const local = part.proxy?.match(LOCAL);
        if (local) add(Number(local[1]), hosts);
      }
    } else {
      const port = classifyRoute(route)?.port;
      if (port) add(port, hosts);
    }
  }
  return out;
}

/** port → hostnames, from nginx's enabled sites. Empty when nginx cannot be read. */
async function nginxHostsByPort(node: SshTarget): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  const files = await readNginxFiles(node).catch(() => new Map<string, string>());
  for (const text of files.values()) {
    for (const site of sitesOf(text)) {
      if (site.kind === 'proxy' && site.port) out.set(site.port, [...new Set([...(out.get(site.port) ?? []), ...site.hosts])]);
    }
  }
  return out;
}

/** Every running container on the node, each published port mapped to its hostnames and its panel app. */
export async function dockerView(node: SshTarget): Promise<DockerContainerView[]> {
  const [containers, config, nginx, apps] = await Promise.all([
    listDockerContainers(node),
    getCaddyConfig(node).catch(() => null),
    nginxHostsByPort(node),
    prisma.application.findMany({ where: { serverId: node.id, port: { not: null } }, select: { id: true, name: true, runtime: true, port: true } }),
  ]);
  const caddy = config ? caddyHostsByPort(config) : new Map<number, string[]>();
  return containers.map((container) => ({
    ...container,
    maps: container.ports.map((port) => {
      const app = apps.find((row) => row.port === port);
      return {
        port,
        nginxHosts: nginx.get(port) ?? [],
        caddyHosts: caddy.get(port) ?? [],
        app: app ? { id: app.id, name: app.name, runtime: app.runtime } : null,
      };
    }),
  }));
}

export type DockerImportResult = { id: string; created: boolean; hosts: string[]; skippedHosts: string[] };

/**
 * Make one container's port an app. The app already on that port (a Caddy sync
 * found it as a plain proxy, say) becomes the container's; otherwise a new,
 * unassigned app is created. Hostnames another app holds stay with it.
 */
export async function importDockerContainer(node: SshTarget, userId: string, name: string, port: number): Promise<DockerImportResult> {
  const view = await dockerView(node);
  const container = view.find((c) => c.name === name);
  if (!container) throw new Error(`No running container named ${name} on this node`);
  const map = container.maps.find((m) => m.port === port);
  if (!map) throw new Error(`${name} does not publish port ${port}`);

  const wanted = [...new Set([...map.caddyHosts, ...map.nginxHosts])];
  const held = await prisma.appDomain.findMany({ where: { host: { in: wanted }, path: '' }, select: { host: true, applicationId: true } });
  const hosts = wanted.filter((host) => !held.some((row) => row.host === host && row.applicationId !== map.app?.id));
  const skippedHosts = wanted.filter((host) => !hosts.includes(host));

  const fields = {
    serverId: node.id,
    runtime: 'DOCKER',
    port,
    serve: { kind: 'proxy', port },
    status: container.status.startsWith('Up') ? 'RUNNING' : 'STOPPED',
    // the compose folder, when compose started it — never deleted with the app (appTeardownService)
    rootPath: container.dir ?? null,
    lastSyncedAt: new Date(),
  } as const;

  if (map.app) {
    const zones = await zonesFor(hosts);
    const taken = new Set(held.filter((row) => row.applicationId === map.app!.id).map((row) => row.host));
    await prisma.application.update({
      where: { id: map.app.id },
      data: {
        ...fields,
        domains: { create: zones.filter((z) => !taken.has(z.host)).map((z) => ({ host: z.host, path: '', domainId: z.domainId })) },
      },
    });
    return { id: map.app.id, created: false, hosts, skippedHosts };
  }

  const zones = await zonesFor(hosts);
  const app = await createApplicationWithSource(
    {
      name,
      // the type is the panel's build recipe, and nothing here is built by the panel;
      // an adopted proxy is typed the way the Caddy sync types one
      type: 'NODEJS',
      userId,
      ...fields,
      domains: { create: zones.map((z) => ({ host: z.host, path: '', domainId: z.domainId })) },
    },
    {},
  );
  return { id: app.id, created: true, hosts, skippedHosts };
}
