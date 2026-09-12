import { getSftp, exec, type SshTarget } from './runner';
import type { Stats } from 'ssh2';

/**
 * The `fs/promises` subset the deploy path uses, against a provisioning node.
 *
 * Deliberately mirrors the node: API — same names, same argument order, same
 * "reject on missing" semantics — so moving a call site is a one-word change
 * (`fs.` -> `rfs.`, plus the server) rather than a rewrite. Anything the deploy
 * path does not use is absent on purpose.
 *
 * File operations go over SFTP on the same pooled SSH connection, not by
 * shelling out. `readlink`, `symlink` and an atomic `rename` have exact SFTP
 * calls; reimplementing them as quoted shell commands would be more code and
 * more ways to be wrong. Recursion is the exception — `mkdir -p` and `rm -rf`
 * are one round trip each where an SFTP walk would be many.
 *
 * Everything runs as the `larika` user, never root. That works because
 * cb-provision-org makes each tenant home `cb-<slug>:larika` mode 2770 —
 * group access for the control plane is the reason that group is set at all.
 * Operations genuinely needing root still go through the two sudo scripts.
 */

/** ENOENT, so callers can keep doing `.catch(() => null)` on an absent file. */
const SFTP_NO_SUCH_FILE = 2;

function wrap<T>(fn: (cb: (err: any, result?: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    fn((err, result) => {
      if (err) {
        // ssh2 reports a numeric SFTP status; give it the `code` shape callers
        // already branch on so `err.code === 'ENOENT'` keeps working.
        if (err.code === SFTP_NO_SUCH_FILE) err.code = 'ENOENT';
        return reject(err);
      }
      resolve(result as T);
    });
  });
}

export async function readFile(server: SshTarget, path: string): Promise<Buffer>;
export async function readFile(server: SshTarget, path: string, encoding: 'utf-8' | 'utf8'): Promise<string>;
export async function readFile(server: SshTarget, path: string, encoding?: string): Promise<Buffer | string> {
  const sftp = await getSftp(server);
  const buf = await wrap<Buffer>((cb) => sftp.readFile(path, cb));
  return encoding ? buf.toString('utf8') : buf;
}

export async function writeFile(
  server: SshTarget,
  path: string,
  data: string | Buffer,
  opts: { mode?: number } = {}
): Promise<void> {
  const sftp = await getSftp(server);
  await wrap<void>((cb) => sftp.writeFile(path, data, opts.mode ? { mode: opts.mode } : {}, cb));
}

export async function appendFile(server: SshTarget, path: string, data: string): Promise<void> {
  const sftp = await getSftp(server);
  await wrap<void>((cb) => sftp.appendFile(path, data, {}, cb));
}

export async function readdir(server: SshTarget, path: string): Promise<string[]> {
  const sftp = await getSftp(server);
  const entries = await wrap<any[]>((cb) => sftp.readdir(path, cb));
  return entries.map((e) => e.filename);
}

export async function stat(server: SshTarget, path: string): Promise<Stats> {
  const sftp = await getSftp(server);
  return wrap<Stats>((cb) => sftp.stat(path, cb));
}

/** Resolves when the path exists, rejects when it does not — same contract as fs.access. */
export async function access(server: SshTarget, path: string): Promise<void> {
  await stat(server, path);
}

export async function readlink(server: SshTarget, path: string): Promise<string> {
  const sftp = await getSftp(server);
  return wrap<string>((cb) => sftp.readlink(path, cb));
}

/** Argument order matches fs.symlink: the target first, then the link to create. */
export async function symlink(server: SshTarget, target: string, path: string): Promise<void> {
  const sftp = await getSftp(server);
  await wrap<void>((cb) => sftp.symlink(target, path, cb));
}

/**
 * Atomic on the node's filesystem, which is what makes the `current` symlink
 * swap safe: a request either sees the old release or the new one, never a
 * missing link.
 */
export async function rename(server: SshTarget, from: string, to: string): Promise<void> {
  const sftp = await getSftp(server);
  await wrap<void>((cb) => sftp.rename(from, to, cb));
}

export async function unlink(server: SshTarget, path: string): Promise<void> {
  const sftp = await getSftp(server);
  await wrap<void>((cb) => sftp.unlink(path, cb));
}

/** Always recursive, like the only form the deploy path uses. */
export async function mkdir(server: SshTarget, path: string): Promise<void> {
  await exec(server, ['mkdir', '-p', '--', path], { timeout: 30_000 });
}

/**
 * `rm -rf` semantics. `force` swallows a missing path exactly as fs.rm does;
 * without it, removing something absent is an error the caller should see.
 */
export async function rm(
  server: SshTarget,
  path: string,
  opts: { recursive?: boolean; force?: boolean } = {}
): Promise<void> {
  // Refusing bare "/" is cheap insurance: this runs rm -rf with a path built
  // from database values, and a bug upstream that yields "/" must not be
  // survivable.
  if (path === '/' || path.trim() === '') throw new Error(`Refusing to rm ${JSON.stringify(path)}`);
  const flags = ['-f'];
  if (opts.recursive) flags.push('-r');
  try {
    await exec(server, ['rm', ...flags, '--', path], { timeout: 60_000 });
  } catch (err) {
    if (!opts.force) throw err;
  }
}

/** Convenience for the very common `fs.access(p).then(() => true).catch(() => false)`. */
export async function exists(server: SshTarget, path: string): Promise<boolean> {
  return stat(server, path).then(() => true).catch(() => false);
}

/** Convenience for `fs.stat(p).then(s => s.isDirectory()).catch(() => false)`. */
export async function isDirectory(server: SshTarget, path: string): Promise<boolean> {
  return stat(server, path).then((s) => s.isDirectory()).catch(() => false);
}
