import { prisma } from '../lib/prisma';
import { decrypt, encrypt } from '../lib/secretBox';
import { exec } from '../lib/runner';
import * as rfs from '../lib/remoteFs';
import { orgHome } from '../lib/appPaths';
import { orgRedisOnNode } from './orgProvisionService';
import { ProvisionError } from './databaseProvisionService';

/**
 * Redis, one server per organization per node (runner/cb-org-redis.sh).
 *
 * Not shared between tenants: one Redis for everyone would share its memory
 * cap (one tenant's keys evict another's), its single thread, and FLUSHDB. Per
 * organization, the process runs as the org's user inside its slice, so the
 * org's own CPU/memory caps hold it too.
 *
 * A "Redis database" in the panel is one of that server's 16 numbered
 * databases (config.index), for one app say — separate keyspaces, one password.
 * Loopback only: an app reaches the Redis on its own node, never another's.
 */

const PORT_BASE = Number(process.env.ORG_REDIS_PORT_BASE || 30_000);
const UID_BASE = Number(process.env.ORG_UID_BASE || 200_000);
const MAX_MEMORY = process.env.ORG_REDIS_MAXMEMORY || '128M';
const DATABASES = 16;

/**
 * The org's port, the same on every node: derived from its UID like its subuid
 * range, above the app port pool (20000–29999). Pure; throws ProvisionError.
 */
export function redisPortFor(uid: number | null): number {
  if (uid === null || uid < UID_BASE) {
    throw new ProvisionError('This workspace was provisioned before UIDs were assigned — Redis needs a panel-assigned UID');
  }
  const port = PORT_BASE + (uid - UID_BASE);
  if (port > 65_535) throw new ProvisionError('No Redis port left for this workspace');
  return port;
}

export type RedisConfig = { serverId: string; index: number };

export function redisConfigOf(config: unknown): RedisConfig {
  const c = (config ?? {}) as Partial<RedisConfig>;
  if (typeof c.serverId !== 'string' || !Number.isInteger(c.index)) throw new ProvisionError('This Redis database has no node or index');
  return { serverId: c.serverId, index: c.index! };
}

/** The lowest numbered database the org does not use yet on that node. */
export async function freeRedisIndex(organizationId: string, serverId: string): Promise<number> {
  const rows = await prisma.database.findMany({ where: { organizationId, type: 'REDIS' }, select: { config: true } });
  const used = new Set(
    rows.map((row) => row.config as Partial<RedisConfig> | null).filter((c) => c?.serverId === serverId).map((c) => c!.index),
  );
  for (let index = 0; index < DATABASES; index++) if (!used.has(index)) return index;
  throw new ProvisionError(`This workspace already uses all ${DATABASES} Redis databases on that node`);
}

/** Make the org's Redis run on the node (idempotent) and return how to reach it. */
async function ensureOrgRedis(organizationId: string, serverId: string): Promise<{ port: number; password: string }> {
  const orgNode = await prisma.orgNode.findUnique({
    where: { organizationId_serverId: { organizationId, serverId } },
    include: { organization: { select: { slug: true, uid: true } }, server: true },
  });
  if (!orgNode || orgNode.state !== 'DONE') {
    throw new ProvisionError('The workspace is not provisioned on that node yet — provision it there first');
  }
  const { slug, uid } = orgNode.organization;
  const port = redisPortFor(uid);
  await orgRedisOnNode(slug, orgNode.server, port, MAX_MEMORY);
  // made on the node, never sent there: read back and kept for the credentials
  const password = (await rfs.readFile(orgNode.server, `${orgHome(slug)}/.redis/password`, 'utf8')).trim();
  if (!password) throw new Error('Redis started without a password file');
  await prisma.orgNode.update({ where: { id: orgNode.id }, data: { redisPasswordEnc: encrypt(password) } });
  return { port, password };
}

/** provisionDatabase for a Redis row: records RUNNING, or ERROR with the reason. */
export async function provisionRedisDatabase(id: string): Promise<{ ok: boolean; error?: string }> {
  const db = await prisma.database.findUnique({ where: { id } });
  if (!db?.organizationId) throw new ProvisionError('This Redis database has no workspace');
  const { serverId, index } = redisConfigOf(db.config);
  try {
    const { port } = await ensureOrgRedis(db.organizationId, serverId);
    await prisma.database.update({
      where: { id },
      data: { status: 'RUNNING', lastError: null, port, connectionString: `redis://127.0.0.1:${port}/${index}` },
    });
    return { ok: true };
  } catch (error: any) {
    const message = String(error?.message ?? error ?? 'provisioning failed').slice(0, 500);
    await prisma.database.update({ where: { id }, data: { status: 'ERROR', lastError: message } }).catch(() => {});
    if (error instanceof ProvisionError) throw error;
    return { ok: false, error: message };
  }
}

async function reach(db: { organizationId: string | null; config: unknown }) {
  if (!db.organizationId) throw new ProvisionError('This Redis database has no workspace');
  const { serverId, index } = redisConfigOf(db.config);
  const orgNode = await prisma.orgNode.findUnique({
    where: { organizationId_serverId: { organizationId: db.organizationId, serverId } },
    include: { organization: { select: { uid: true } }, server: true },
  });
  if (!orgNode?.redisPasswordEnc) throw new ProvisionError('Redis is not running for this workspace on that node yet — retry provisioning');
  return { node: orgNode.server, serverId, index, port: redisPortFor(orgNode.organization.uid), password: decrypt(orgNode.redisPasswordEnc) };
}

/**
 * Credentials in databaseCredentials' shape. With `appNodeId`, refused unless
 * the app runs on the Redis's own node — it listens on loopback only.
 */
export async function redisCredentials(db: { organizationId: string | null; config: unknown }, appNodeId?: string | null) {
  const { serverId, index, port, password } = await reach(db);
  if (appNodeId !== undefined && appNodeId !== serverId) {
    throw new ProvisionError("This Redis runs on another node than the app — create one on the app's node");
  }
  const host = '127.0.0.1';
  return {
    engine: 'REDIS' as const,
    host,
    port,
    database: String(index),
    username: 'default',
    password,
    tls: false,
    url: `redis://:${encodeURIComponent(password)}@${host}:${port}/${index}`,
  };
}

/** dropDatabase for a Redis row: empties its numbered database. The server keeps running. */
export async function flushRedisDatabase(db: { organizationId: string | null; config: unknown; status: string }): Promise<void> {
  if (db.status !== 'RUNNING') return;
  const { node, index, port, password } = await reach(db);
  // the password on stdin, never in argv where ps shows it
  const { stdout } = await exec(
    node,
    ['sh', '-c', 'IFS= read -r REDISCLI_AUTH; export REDISCLI_AUTH; exec redis-cli -h 127.0.0.1 -p "$1" -n "$2" FLUSHDB', 'sh', String(port), String(index)],
    { input: password + '\n', timeout: 30_000 },
  );
  if (!/OK/.test(stdout)) throw new Error(stdout.trim() || 'FLUSHDB failed');
}
