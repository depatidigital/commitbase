import * as fs from 'fs/promises';
import * as net from 'net';
import { execFile } from 'child_process';
import { prisma } from './prisma';
import { appDirFor } from './appPaths';
import { serverForApplication } from './servers';
import { exec, forwardTcp, type SshTarget, type ExecResult } from './runner';
import * as rfs from './remoteFs';
import { OS_ISOLATION_ENABLED } from '../services/orgProvisionService';

/**
 * Where an application's files are, and the one way to touch them.
 *
 * With OS isolation on, an app in an organization lives in that org's home on
 * the app's node, and every file operation and command goes over SSH (SFTP via
 * remoteFs, commands via runner.exec) as the node's SSH user — who reaches the
 * tenant home through the `larika` group. Everything else is the legacy local
 * APPS_DIR on the panel: isolation off (dev), apps without an organization, and
 * static sites, which are built on the panel and served from R2.
 *
 * Deploy code is written once against this interface; `node` says which side
 * it is on when it genuinely differs (health checks, isolated builds).
 */

export interface RunOptions {
  cwd?: string;
  timeout?: number;
  /**
   * Extra environment. Locally merged into the child's env; remotely read from
   * stdin into shell variables, so a secret (a git token) never reaches argv,
   * where every user on the node could read it in `ps`.
   */
  env?: Record<string, string>;
}

export interface AppFs {
  /** The node, or null for the panel's own disk. */
  node: SshTarget | null;
  /** Root of this application's tree on that side. */
  appDir: string;

  readFile(p: string): Promise<Buffer>;
  readText(p: string): Promise<string>;
  writeFile(p: string, data: string | Buffer, opts?: { mode?: number }): Promise<void>;
  appendFile(p: string, data: string): Promise<void>;
  readdir(p: string): Promise<string[]>;
  exists(p: string): Promise<boolean>;
  isDirectory(p: string): Promise<boolean>;
  /** Size in bytes, or null when absent. */
  size(p: string): Promise<number | null>;
  readlink(p: string): Promise<string>;
  symlink(target: string, p: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(p: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  /** Always recursive. */
  mkdir(p: string): Promise<void>;
  /** argv, never a shell string. Rejects on a non-zero exit. */
  run(argv: string[], opts?: RunOptions): Promise<ExecResult>;
  /** Is anything listening on this port on that side's loopback? */
  portInUse(port: number): Promise<boolean>;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

function localAppFs(appDir: string): AppFs {
  return {
    node: null,
    appDir,
    readFile: (p) => fs.readFile(p),
    readText: (p) => fs.readFile(p, 'utf-8'),
    writeFile: (p, data, opts = {}) => fs.writeFile(p, data, opts.mode ? { mode: opts.mode } : {}),
    appendFile: (p, data) => fs.appendFile(p, data),
    readdir: (p) => fs.readdir(p),
    exists: (p) => fs.access(p).then(() => true, () => false),
    isDirectory: (p) => fs.stat(p).then((s) => s.isDirectory(), () => false),
    size: (p) => fs.stat(p).then((s) => s.size, () => null),
    readlink: (p) => fs.readlink(p),
    symlink: (target, p) => fs.symlink(target, p),
    rename: (from, to) => fs.rename(from, to),
    rm: (p, opts = {}) => fs.rm(p, opts),
    mkdir: (p) => fs.mkdir(p, { recursive: true }).then(() => undefined),
    run: ([cmd, ...args], opts = {}) =>
      new Promise((resolve, reject) => {
        execFile(
          cmd!,
          args,
          { cwd: opts.cwd, timeout: opts.timeout, env: { ...process.env, ...opts.env }, maxBuffer: 64 * 1024 * 1024 },
          (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })),
        );
      }),
    portInUse: (port) =>
      new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(true));
        server.listen(port, '127.0.0.1', () => server.close(() => resolve(false)));
      }),
  };
}

/**
 * The argv (and stdin) that runs `argv` on a node: umask 002, then any env
 * read from stdin, then `cd`, then exec. Exported for the self-check.
 *
 * umask 002: the build runs as larika-build, not as the SSH user, and has to
 * write into what the SSH user just created (releases, caches).
 */
export function remoteCommand(argv: string[], opts: RunOptions = {}): { argv: string[]; input?: string } {
  const env = opts.env ?? {};
  const names = Object.keys(env);
  for (const name of names) {
    if (!ENV_NAME.test(name)) throw new Error(`Invalid environment variable name: ${name}`);
    if (/[\r\n]/.test(env[name]!)) throw new Error(`Environment variable ${name} cannot contain a newline`);
  }
  const script = [
    'umask 002;',
    ...names.map((name) => `IFS= read -r ${name}; export ${name};`),
    opts.cwd ? 'cd -- "$1" || exit 1; shift;' : '',
    'exec "$@"',
  ].join(' ');
  return {
    argv: ['sh', '-c', script, 'sh', ...(opts.cwd ? [opts.cwd] : []), ...argv],
    ...(names.length > 0 && { input: names.map((name) => env[name] + '\n').join('') }),
  };
}

function remoteAppFs(node: SshTarget, appDir: string): AppFs {
  return {
    node,
    appDir,
    readFile: (p) => rfs.readFile(node, p),
    readText: (p) => rfs.readFile(node, p, 'utf-8'),
    writeFile: (p, data, opts) => rfs.writeFile(node, p, data, opts),
    appendFile: (p, data) => rfs.appendFile(node, p, data),
    readdir: (p) => rfs.readdir(node, p),
    exists: (p) => rfs.exists(node, p),
    isDirectory: (p) => rfs.isDirectory(node, p),
    size: (p) => rfs.stat(node, p).then((s) => s.size, () => null),
    readlink: (p) => rfs.readlink(node, p),
    symlink: (target, p) => rfs.symlink(node, target, p),
    rename: (from, to) => rfs.rename(node, from, to),
    rm: (p, opts) => rfs.rm(node, p, opts),
    // through run, not remoteFs.mkdir: umask 002 keeps new dirs group-writable
    mkdir: (p) => remoteAppFs(node, appDir).run(['mkdir', '-p', '--', p]).then(() => undefined),
    run: async (argv, opts = {}) => {
      const wrapped = remoteCommand(argv, opts);
      return exec(node, wrapped.argv, {
        ...(opts.timeout !== undefined && { timeout: opts.timeout }),
        ...(wrapped.input !== undefined && { input: wrapped.input }),
      });
    },
    // A direct-tcpip channel to a closed port is refused; an open one connects.
    portInUse: (port) =>
      forwardTcp(node, '127.0.0.1', port).then(
        (stream) => {
          stream.close();
          return true;
        },
        () => false,
      ),
  };
}

/** The node and directory an application's files belong on. */
export async function appFsFor(applicationId: string): Promise<AppFs> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { type: true, organization: { select: { slug: true } } },
  });
  if (!app) throw new Error(`Unknown application: ${applicationId}`);

  const slug = app.organization?.slug;
  if (OS_ISOLATION_ENABLED && slug && app.type !== 'STATIC') {
    // the app's own node — organizations span nodes (lib/servers.ts)
    return remoteAppFs(await serverForApplication(applicationId), appDirFor(applicationId, slug));
  }
  return localAppFs(appDirFor(applicationId, null));
}

/** Same, by hostname — for the log endpoints that only carry a domain. */
export async function appFsForDomain(domain: string): Promise<AppFs | null> {
  const app = await prisma.application.findFirst({ where: { domain }, select: { id: true } });
  return app ? appFsFor(app.id) : null;
}
