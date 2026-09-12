import * as fs from 'fs';
import * as path from 'path';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { exec, execRoot, type SshTarget, type ExecOptions } from '../lib/runner';
import { serverForApplication } from '../lib/servers';
import { liveLog } from '../lib/liveLog';
import { ORG_SLUG_RE, APP_ID_RE, osUserFor } from '../lib/appPaths';

/**
 * Per-organization OS isolation.
 *
 * An organization can span nodes: each application has its own node, and the
 * org is provisioned — OS user, home, disk quota, cgroup slice, PHP-FPM pool —
 * on each node it uses, and only there. That presence is an OrgNode row, and
 * the provisioning queue lives on those rows. The OS user is `cb-<slug>` with
 * the org's one UID on every node, so files keep their owner between nodes.
 *
 * Nothing is installed on a node: the runner scripts live in this repo and
 * their text is sent with every call as `bash -c <script> <name> <args...>`.
 * A node therefore always runs the script that matches this panel's version.
 * The price is that the SSH user needs root (root itself, NOPASSWD: ALL, or
 * sudo with the stored login password) — see execRoot in runner.ts.
 *
 * Arguments are passed as an array, never as a shell string; runner.ts quotes
 * each element (the script text included), so nothing from the database can be
 * read as a shell metacharacter on the way to a root command. The scripts
 * revalidate their own arguments as well.
 */

// Tenant apps always run isolated on their organization's node — there is no
// "build on the panel" mode to fall back to (it built on whatever machine ran
// the backend, a laptop included). Static sites are the exception: they build
// on the panel and are served from R2.

// Same depth from src/services (tsx) and dist/services (node): backend/<x>/services → repo root.
const RUNNER_DIR = path.resolve(__dirname, '../../../runner');
const scripts = new Map<string, string>();

function script(name: 'cb-provision-org' | 'cb-app-unit'): string {
  let text = scripts.get(name);
  if (!text) {
    text = fs.readFileSync(path.join(RUNNER_DIR, `${name}.sh`), 'utf8');
    scripts.set(name, text);
  }
  return text;
}

const DEFAULT_DISK_QUOTA = process.env.ORG_DISK_QUOTA || '20G';
const DEFAULT_CPU_QUOTA = process.env.ORG_CPU_QUOTA || '50%';
const DEFAULT_MEMORY_MAX = process.env.ORG_MEMORY_MAX || '1G';

/**
 * Org UIDs come from their own range, far above anything useradd hands out on
 * its own (1000+) and below the systemd dynamic-user ranges (61184+ are too
 * close; 200000+ is clear of both), so an org UID never collides with a
 * node's local accounts.
 */
const ORG_UID_BASE = Number(process.env.ORG_UID_BASE || 200_000);

const QUOTA_RE = /^[0-9]+[MG]$/;
const CPU_RE = /^[0-9]+%$/;

function assertSlug(slug: string) {
  if (!ORG_SLUG_RE.test(slug)) throw new Error(`Invalid organization slug: ${slug}`);
}

/** Run one runner script as root on the node, its text sent inline. $0 is the script name. */
function runScript(server: SshTarget, name: 'cb-provision-org' | 'cb-app-unit', args: string[], opts: ExecOptions = {}) {
  return execRoot(server, ['bash', '-c', script(name), name, ...args], opts);
}

async function sudo(
  server: SshTarget,
  name: 'cb-provision-org' | 'cb-app-unit',
  args: string[],
  timeout = 60_000,
  onOutput?: (text: string) => void,
): Promise<string> {
  const { stdout } = await runScript(server, name, args, { timeout, ...(onOutput && { onOutput }) });
  return stdout.trim();
}

/**
 * The org's UID, assigned once. An org provisioned before UIDs were tracked
 * already has cb-<slug> on this node with whatever UID useradd picked — that
 * one is adopted rather than fought, since its files are already owned by it.
 * Otherwise the next free number in the org range.
 */
async function uidFor(org: { id: string; slug: string; uid: number | null }, node: SshTarget): Promise<number> {
  if (org.uid !== null) return org.uid;

  const existing = await exec(node, ['id', '-u', osUserFor(org.slug)], { timeout: 15_000 })
    .then(({ stdout }) => Number(stdout.trim()))
    .catch(() => null);

  for (let attempt = 0; attempt < 5; attempt++) {
    const uid =
      existing && Number.isInteger(existing)
        ? existing
        : Math.max(ORG_UID_BASE - 1, (await prisma.organization.aggregate({ _max: { uid: true } }))._max.uid ?? 0) + 1;
    try {
      // conditional on uid still being null: two provisions of one org racing agree on one value
      const set = await prisma.organization.updateMany({ where: { id: org.id, uid: null }, data: { uid } });
      if (set.count === 0) return (await prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { uid: true } })).uid!;
      return uid;
    } catch (err: any) {
      // P2002: another org took this number first — only possible for a fresh allocation
      if (err?.code !== 'P2002' || existing) {
        throw err?.code === 'P2002'
          ? new Error(`${osUserFor(org.slug)} on this node has UID ${existing}, which another organization already owns — renumber it by hand`)
          : err;
      }
    }
  }
  throw new Error('Could not allocate a UID for this organization — retry');
}

export interface ProvisionLimits {
  diskQuota?: string;
  cpuQuota?: string;
  memoryMax?: string;
}

/**
 * Create (or repair) the org's OS user, home, disk quota, cgroup slice and
 * PHP-FPM pool on one node. Idempotent — safe to re-run to repair ownership or
 * apply new limits, and safe to retry after a dropped connection.
 */
export async function provisionOrgOnNode(
  org: { id: string; slug: string; uid: number | null },
  node: SshTarget,
  opts: ProvisionLimits & { onOutput?: (text: string) => void } = {},
): Promise<string> {
  assertSlug(org.slug);

  const diskQuota = opts.diskQuota || DEFAULT_DISK_QUOTA;
  const cpuQuota = opts.cpuQuota || DEFAULT_CPU_QUOTA;
  const memoryMax = opts.memoryMax || DEFAULT_MEMORY_MAX;

  if (!QUOTA_RE.test(diskQuota)) throw new Error(`Invalid disk quota: ${diskQuota}`);
  if (!CPU_RE.test(cpuQuota)) throw new Error(`Invalid CPU quota: ${cpuQuota}`);
  if (!QUOTA_RE.test(memoryMax)) throw new Error(`Invalid memory max: ${memoryMax}`);

  const uid = await uidFor(org, node);
  return sudo(node, 'cb-provision-org', [org.slug, diskQuota, cpuQuota, memoryMax, String(uid)], 60_000, opts.onOutput);
}

export type AppUnitAction = 'install' | 'start' | 'stop' | 'restart' | 'remove' | 'status' | 'chown' | 'cancel-build';

const BUILD_MEMORY_MAX = process.env.BUILD_MEMORY_MAX || '2G';
const BUILD_CPU_WEIGHT = process.env.BUILD_CPU_WEIGHT || '50';

/** Manage an app's unit on the node the app runs on. */
export async function appUnit(action: AppUnitAction, slug: string, applicationId: string): Promise<string> {
  assertSlug(slug);
  if (!APP_ID_RE.test(applicationId)) throw new Error(`Invalid application id: ${applicationId}`);
  return sudo(await serverForApplication(applicationId), 'cb-app-unit', [action, slug, applicationId]);
}

/**
 * Run <app-dir>/build.sh inside the build cgroup (memory-capped, low CPU/IO
 * weight) on the app's node. Resolves with the combined output; rejects with it
 * attached when the script fails. Fifteen minutes.
 * `onOutput` gets the output as it prints, for the live build log.
 */
export async function appBuild(slug: string, applicationId: string, onOutput?: (text: string) => void): Promise<string> {
  assertSlug(slug);
  if (!APP_ID_RE.test(applicationId)) throw new Error(`Invalid application id: ${applicationId}`);

  const { stdout, stderr } = await runScript(
    await serverForApplication(applicationId),
    'cb-app-unit',
    ['build', slug, applicationId, BUILD_MEMORY_MAX, BUILD_CPU_WEIGHT],
    { timeout: 900_000, maxBuffer: 64 * 1024 * 1024, ...(onOutput && { onOutput }) }
  );
  return stdout + (stderr ? '\n' + stderr : '');
}

/**
 * Provisioning is recorded in the existing Log model so an admin can see what
 * happened without shell access. metadata.scope = 'provisioning' is what the
 * admin log endpoint filters on.
 */
async function logProvision(
  level: 'INFO' | 'WARN' | 'ERROR',
  message: string,
  userId: string | undefined,
  metadata: Record<string, unknown>
) {
  if (!userId) return;
  try {
    await prisma.log.create({
      data: { level, message, userId, metadata: { scope: 'provisioning', ...metadata } as any },
    });
  } catch (err) {
    // A logging failure must never take down a provisioning run.
    console.error('Failed to write provisioning log:', err);
  }
}

// --- Queue -------------------------------------------------------------------
//
// Provisioning is a root script on a remote node — seconds on a good day, a
// connect timeout on a bad one. Nothing waits for it: a request flags the
// OrgNode QUEUED, the worker runs it and records DONE or FAILED on the row.
// Same shape as domainProvisionService: kicked in-process, swept by cron for
// what a restart left behind. A deploy that needs the org on its node waits on
// the same row (ensureOrgOnNode).
//
// States: NONE → QUEUED → RUNNING → DONE | FAILED. FAILED is not retried on its
// own — a broken node would fail every minute; an admin or a deploy re-queues.

export interface ProvisionJob extends ProvisionLimits {
  userId?: string;
  trigger: string;
}

/** OrgNodes being provisioned by this process. Anything RUNNING that is not here was orphaned by a restart. */
const running = new Set<string>();

/**
 * Flag an organization for provisioning on a node and kick the worker. Creates
 * the OrgNode the first time. Returns at once; re-queuing replaces the pending request.
 */
export async function queueOrgNode(organizationId: string, serverId: string, job: ProvisionJob): Promise<string | null> {
  const row = await prisma.orgNode.upsert({
    where: { organizationId_serverId: { organizationId, serverId } },
    create: { organizationId, serverId, state: 'QUEUED', job: job as any },
    update: { state: 'QUEUED', error: null, job: job as any },
    select: { id: true },
  });
  void runOrgNode(row.id);
  return row.id;
}

/** Queue every node an organization is on — re-apply limits, repair ownership. */
export async function queueOrgEverywhere(organizationId: string, job: ProvisionJob): Promise<number> {
  const nodes = await prisma.orgNode.findMany({ where: { organizationId }, select: { serverId: true } });
  for (const node of nodes) await queueOrgNode(organizationId, node.serverId, job);
  return nodes.length;
}

/**
 * Run one queued OrgNode. Safe to call twice: claiming QUEUED → RUNNING is the guard.
 * Resolves with a one-line outcome (never rejects) so the cron sweep can report it.
 */
export async function runOrgNode(orgNodeId: string): Promise<string> {
  if (running.has(orgNodeId)) {
    console.log(`[org-provision] ${orgNodeId}: already running in this process — skipped`);
    return `${orgNodeId}: already running`;
  }
  running.add(orgNodeId);
  const started = Date.now();

  try {
    const claimed = await prisma.orgNode.updateMany({
      where: { id: orgNodeId, state: 'QUEUED' },
      // the previous run's output would read as this run's
      data: { state: 'RUNNING', log: null },
    });
    if (claimed.count === 0) return `${orgNodeId}: not queued`;

    const row = await prisma.orgNode.findUniqueOrThrow({
      where: { id: orgNodeId },
      include: { organization: { select: { id: true, slug: true, uid: true } }, server: true },
    });
    const { organization: org, server } = row;
    const { userId, trigger, ...limits } = (row.job ?? { trigger: 'none' }) as unknown as ProvisionJob;
    const label = `${org.slug}@${server.name}`;
    const where = `${server.name} (${server.hostname})`;
    console.log(`[org-provision] ${label}: RUNNING — trigger=${trigger ?? 'none'} user=${userId ?? 'none'} limits=${JSON.stringify(limits)}`);

    // followed live from the Organizations page
    const live = liveLog((text) => prisma.orgNode.update({ where: { id: orgNodeId }, data: { log: text } }));
    live.push(`provisioning ${osUserFor(org.slug)} on ${where}\n`);
    const audit = { organizationId: org.id, slug: org.slug, serverId: server.id, server: server.name, trigger };

    try {
      const output = await provisionOrgOnNode(org, server, { ...limits, onOutput: (text) => live.push(text) });
      await live.stop();
      await prisma.orgNode.update({
        where: { id: orgNodeId },
        data: { state: 'DONE', error: null, log: live.text || output || null, job: Prisma.DbNull, provisionedAt: new Date() },
      });
      await logProvision('INFO', `Provisioned ${osUserFor(org.slug)} on ${server.name}`, userId, { ...audit, output });
      console.log(`[org-provision] ${label}: DONE in ${Date.now() - started}ms`);
      return `${label}: done`;
    } catch (err: any) {
      const message = String(err?.stderr || err?.message || err);
      await live.stop();
      // a failure before any output (no SSH, bad slug) still gets a log line
      if (!live.text.includes(message)) live.push(`\n${message}\n`);
      await prisma.orgNode.update({
        where: { id: orgNodeId },
        data: { state: 'FAILED', error: message.slice(0, 1000), log: live.text },
      });
      await logProvision('ERROR', `Provisioning ${org.slug} on ${server.name} failed: ${message}`, userId, audit);
      console.error(`[org-provision] ${label}: FAILED after ${Date.now() - started}ms on ${where} — ${message}`);
      return `${label}: failed (${(message.split('\n')[0] ?? '').slice(0, 200)})`;
    }
  } catch (err: any) {
    console.error(`[org-provision] worker crashed for ${orgNodeId}:`, err);
    return `${orgNodeId}: worker error (${err?.message || err})`;
  } finally {
    running.delete(orgNodeId);
  }
}

const ENSURE_TIMEOUT_MS = 5 * 60_000;

/**
 * Make sure an organization is provisioned on a node before something runs
 * there — the lazy half of "provision only where it is used". Already DONE is
 * a no-op; otherwise it queues (or joins a run in flight) and waits for the
 * outcome, throwing with the node's error when it fails.
 */
export async function ensureOrgOnNode(organizationId: string, serverId: string, job: ProvisionJob): Promise<void> {

  const existing = await prisma.orgNode.findUnique({
    where: { organizationId_serverId: { organizationId, serverId } },
    select: { state: true },
  });
  if (existing?.state === 'DONE') return;
  if (existing?.state !== 'QUEUED' && existing?.state !== 'RUNNING') await queueOrgNode(organizationId, serverId, job);

  const deadline = Date.now() + ENSURE_TIMEOUT_MS;
  for (;;) {
    const row = await prisma.orgNode.findUniqueOrThrow({
      where: { organizationId_serverId: { organizationId, serverId } },
      select: { state: true, error: true },
    });
    if (row.state === 'DONE') return;
    if (row.state === 'FAILED') throw new Error(`Provisioning the organization on this server failed: ${row.error ?? 'unknown error'}`);
    if (Date.now() > deadline) throw new Error('Provisioning the organization on this server is taking too long — check its provisioning log');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/** Cron sweep: requeue RUNNING rows a restart orphaned, then run every QUEUED one. */
export async function provisionQueuedOrgs(): Promise<string> {

  // ponytail: "not in this process's set" = orphaned, valid for one replica only (see cron.ts).
  const requeued = await prisma.orgNode.updateMany({
    where: { state: 'RUNNING', id: { notIn: [...running] } },
    data: { state: 'QUEUED' },
  });
  if (requeued.count) console.warn(`[org-provision] requeued ${requeued.count} node(s) left RUNNING by a restart`);

  const queued = await prisma.orgNode.findMany({ where: { state: 'QUEUED' }, select: { id: true } });
  const parts: string[] = [];
  if (requeued.count) parts.push(`${requeued.count} requeued`);
  if (queued.length === 0) return ['nothing queued', ...parts].join('; ');

  const outcomes: string[] = [];
  for (const row of queued) outcomes.push(await runOrgNode(row.id));
  return [`${queued.length} org node(s) processed`, ...parts, ...outcomes].join('; ');
}

/** How API responses include an organization's nodes — enough for the list, the badges and the live log. */
export const orgNodesInclude = {
  select: {
    id: true,
    serverId: true,
    state: true,
    error: true,
    log: true,
    provisionedAt: true,
    server: { select: { id: true, name: true, status: true } },
  },
  orderBy: { createdAt: 'asc' as const },
};
