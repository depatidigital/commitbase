import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2';
import * as fs from 'fs/promises';

/**
 * Remote command execution.
 *
 * Provisioning nodes are separate machines, so every root command the control
 * plane used to run through execFile now runs over SSH. There is no local
 * branch: the VM the control plane itself runs on is a Server row like any
 * other and is reached the same way, so there is exactly one code path to get
 * right.
 *
 * The node side is unchanged — same two sudo scripts, same sudoers file. Its
 * `!requiretty` entries were already written for a non-tty caller, which is
 * what an SSH exec channel is.
 */

/** The subset of a Server row needed to reach it. Structural, so this file does not import Prisma. */
export interface SshTarget {
  id: string;
  hostname: string;
  sshUser: string;
  sshPort: number;
  sshKeyPath: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Milliseconds before the channel is torn down. Default 60s, same as the old execFile calls. */
  timeout?: number;
  /** Bytes of stdout+stderr to keep. Default 64 MiB — builds are noisy. */
  maxBuffer?: number;
}

/**
 * An exec that exited non-zero. Shaped like child_process's error so the call
 * sites that read `err.stderr` keep working unchanged.
 */
export class RemoteExecError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string,
    readonly server: string
  ) {
    super(message);
    this.name = 'RemoteExecError';
  }
}

const CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Wrap one argv element for /bin/sh.
 *
 * execFile took an argument array, so nothing from the database could ever be
 * read as a shell metacharacter. SSH has no such channel — the remote side
 * always gets a string — so this function is the replacement boundary and the
 * only thing standing between a tenant-controlled string and a root shell.
 *
 * Single quotes suspend every form of shell interpretation, and the only byte
 * that can end them is another single quote, so closing/escaping/reopening on
 * that one byte is exact rather than a blacklist.
 */
export function shellQuote(arg: string): string {
  if (arg.includes('\0')) throw new Error('Refusing to shell-quote an argument containing a NUL byte');
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

export const buildCommand = (argv: string[]): string => argv.map(shellQuote).join(' ');

// One live connection per server, reused across execs. A deploy fires many
// commands back to back and an SSH handshake per command would dominate.
const pool = new Map<string, Promise<Client>>();

export function connect(server: SshTarget): Promise<Client> {
  const existing = pool.get(server.id);
  if (existing) return existing;

  const pending = (async () => {
    const privateKey = await fs.readFile(server.sshKeyPath);
    return await new Promise<Client>((resolve, reject) => {
      const client = new Client();
      const drop = () => {
        // Only evict if this exact connection is still the pooled one; a
        // reconnect that already replaced us must not be thrown away.
        if (pool.get(server.id) === pending) pool.delete(server.id);
      };
      client
        .on('ready', () => resolve(client))
        .on('error', (err) => {
          drop();
          reject(new Error(`SSH connection to ${server.hostname} failed: ${err.message}`));
        })
        .on('close', drop)
        .on('end', drop)
        .connect({
          host: server.hostname,
          port: server.sshPort,
          username: server.sshUser,
          privateKey,
          readyTimeout: CONNECT_TIMEOUT_MS,
          keepaliveInterval: 15_000,
        });
    });
  })();

  pool.set(server.id, pending);
  pending.catch(() => pool.delete(server.id));
  return pending;
}

/**
 * Run a command on a node and resolve with its output.
 *
 * `argv` is an argument array, not a shell string, exactly as execFile took —
 * it is quoted on the way out. Rejects with a RemoteExecError on a non-zero
 * exit so a failed provision is never mistaken for a successful one.
 */
export async function exec(server: SshTarget, argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  if (argv.length === 0) throw new Error('exec requires at least one argument');

  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const client = await connect(server);
  const command = buildCommand(argv);

  return new Promise<ExecResult>((resolve, reject) => {
    client.exec(command, (err, stream: ClientChannel) => {
      if (err) return reject(new Error(`SSH exec on ${server.hostname} failed: ${err.message}`));

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;

      // Keeping the head rather than the tail: a build fails on its first
      // error and the megabytes after it are noise.
      const append = (into: 'out' | 'err', chunk: Buffer) => {
        if (stdout.length + stderr.length >= maxBuffer) {
          truncated = true;
          return;
        }
        const text = chunk.toString('utf8');
        if (into === 'out') stdout += text;
        else stderr += text;
      };

      const timer = setTimeout(() => {
        timedOut = true;
        stream.close();
      }, timeout);

      stream.on('data', (c: Buffer) => append('out', c));
      stream.stderr.on('data', (c: Buffer) => append('err', c));

      stream.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (truncated) stderr += `\n[output truncated at ${maxBuffer} bytes]`;
        if (timedOut) {
          return reject(
            new RemoteExecError(
              `Command timed out after ${timeout}ms on ${server.hostname}: ${argv[0]}`,
              null, stdout, stderr, server.hostname
            )
          );
        }
        if (code !== 0) {
          return reject(
            new RemoteExecError(
              `Command exited ${code} on ${server.hostname}: ${argv[0]}\n${stderr || stdout}`.trim(),
              code, stdout, stderr, server.hostname
            )
          );
        }
        resolve({ stdout, stderr });
      });
    });
  });
}

// SFTP channel per server, opened lazily on the pooled connection. Cached
// because a channel handshake per file operation would swamp a deploy.
const sftpPool = new Map<string, Promise<SFTPWrapper>>();

/** SFTP channel on the node, for the file operations in remoteFs. */
export function getSftp(server: SshTarget): Promise<SFTPWrapper> {
  const existing = sftpPool.get(server.id);
  if (existing) return existing;

  const pending = connect(server).then(
    (client) =>
      new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((err, sftp) => {
          if (err) return reject(new Error(`SFTP on ${server.hostname} failed: ${err.message}`));
          // The channel dies with its connection; drop it so the next call reopens.
          const drop = () => {
            if (sftpPool.get(server.id) === pending) sftpPool.delete(server.id);
          };
          sftp.on('close', drop).on('end', drop).on('error', drop);
          resolve(sftp);
        });
      })
  );

  sftpPool.set(server.id, pending);
  pending.catch(() => sftpPool.delete(server.id));
  return pending;
}

/** Does a path exist on the node? Replaces the local fs.access checks. */
export async function remoteExists(server: SshTarget, remotePath: string): Promise<boolean> {
  try {
    await exec(server, ['test', '-e', remotePath], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Entry names in a directory, or [] when it does not exist. Replaces fs.readdir. */
export async function remoteReadDir(server: SshTarget, remotePath: string): Promise<string[]> {
  try {
    const { stdout } = await exec(server, ['ls', '-1A', '--', remotePath], { timeout: 10_000 });
    return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Close pooled connections. For tests and shutdown. */
export async function closeConnections(): Promise<void> {
  const clients = [...pool.values()];
  pool.clear();
  sftpPool.clear();
  for (const p of clients) {
    await p.then((c) => c.end()).catch(() => {});
  }
}
