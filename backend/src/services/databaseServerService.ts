import net from 'net';
import tls from 'tls';
import { Client as PgClient } from 'pg';
import mysql from 'mysql2/promise';
import type { DatabaseServer, Server } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { forwardTcp, type SshTarget } from '../lib/runner';
import { decrypt } from '../lib/secretBox';

/**
 * Talking to a database server as its admin login.
 *
 * Two ways in. A TUNNEL server runs on one of our nodes and listens only on
 * that node's loopback or private address; the control plane reaches it through
 * the node's SSH connection, so no database port is ever public. A DIRECT
 * server is a managed service, reached over the network and therefore over TLS.
 *
 * Both engines are driven through their own protocol clients (pg, mysql2),
 * never `psql`/`mysql` over SSH: that would put the admin password on a
 * command line on the node.
 */

export type DbServerRow = DatabaseServer & { server?: Server | null };

const CONNECT_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 30_000;

/**
 * A loopback port on the control plane forwarding to host:port as the node
 * sees it — `ssh -L` done in-process, alive for the duration of `fn`.
 *
 * ponytail: a real listening socket rather than handing the SSH channel to the
 * driver as its stream, because pg expects a socket it can connect() and
 * mysql2 wants something else again; a port works for both unchanged. It only
 * listens on 127.0.0.1 and only while one operation runs.
 */
async function withTunnel<T>(
  node: SshTarget,
  host: string,
  port: number,
  fn: (localPort: number) => Promise<T>,
): Promise<T> {
  const sockets = new Set<net.Socket>();

  const listener = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());

    forwardTcp(node, host, port).then(
      (channel) => {
        channel.on('error', () => socket.destroy());
        channel.on('close', () => socket.destroy());
        socket.on('close', () => channel.close());
        socket.pipe(channel).pipe(socket);
      },
      () => socket.destroy(),
    );
  });

  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => resolve());
  });
  const { port: localPort } = listener.address() as net.AddressInfo;

  try {
    return await fn(localPort);
  } finally {
    listener.close();
    for (const socket of sockets) socket.destroy();
  }
}

/** Where the driver should connect: the server itself, or the tunnel's local end. */
async function reach<T>(dbs: DbServerRow, fn: (host: string, port: number) => Promise<T>): Promise<T> {
  if (dbs.mode === 'TUNNEL') {
    if (!dbs.server) throw new Error(`${dbs.name} is a tunnelled server but its node is missing`);
    return withTunnel(dbs.server, dbs.host, dbs.port, (localPort) => fn('127.0.0.1', localPort));
  }
  return fn(dbs.host, dbs.port);
}

/**
 * TLS options for either driver. VERIFY checks the certificate against the
 * configured host even through a tunnel, where the socket itself is 127.0.0.1.
 */
function tlsOptions(dbs: DbServerRow): tls.ConnectionOptions | undefined {
  if (dbs.tlsMode === 'DISABLE') return undefined;
  if (dbs.tlsMode === 'REQUIRE') return { rejectUnauthorized: false };
  return {
    rejectUnauthorized: true,
    ...(dbs.caCert && { ca: dbs.caCert }),
    ...(!net.isIP(dbs.host) && { servername: dbs.host }),
    checkServerIdentity: (_host, cert) => tls.checkServerIdentity(dbs.host, cert),
  };
}

export interface AdminSession {
  query: (sql: string, params?: unknown[]) => Promise<any[]>;
}

/** Open an admin connection, run `fn`, always close it. */
export async function withAdmin<T>(dbs: DbServerRow, fn: (session: AdminSession) => Promise<T>): Promise<T> {
  const password = decrypt(dbs.adminPasswordEnc);
  const ssl = tlsOptions(dbs);

  return reach(dbs, async (host, port) => {
    if (dbs.engine === 'POSTGRESQL') {
      const client = new PgClient({
        host,
        port,
        user: dbs.adminUser,
        password,
        database: 'postgres',
        ssl: ssl ?? false,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        statement_timeout: QUERY_TIMEOUT_MS,
      });
      // a dropped connection mid-operation must not become an uncaught 'error'
      client.on('error', () => {});
      await client.connect();
      try {
        return await fn({ query: async (sql, params) => (await client.query(sql, params as any[])).rows });
      } finally {
        await client.end().catch(() => {});
      }
    }

    if (dbs.engine === 'MYSQL') {
      const connection = await mysql.createConnection({
        host,
        port,
        user: dbs.adminUser,
        password,
        ...(ssl && { ssl: ssl as any }),
        connectTimeout: CONNECT_TIMEOUT_MS,
      });
      connection.on('error', () => {});
      try {
        return await fn({
          query: async (sql, params) => {
            const [rows] = await connection.query({ sql, timeout: QUERY_TIMEOUT_MS }, params as any[]);
            return rows as any[];
          },
        });
      } finally {
        await connection.end().catch(() => {});
      }
    }

    throw new Error(`${dbs.engine} is not a database server engine`);
  });
}

export interface Inspection {
  version: string;
  /** what the admin login can do, among what we need, plus "superuser" */
  rights: string[];
  /** needed and missing — databases cannot be created until these are granted */
  missing: string[];
  superuser: boolean;
}

/**
 * Parse `SHOW GRANTS` lines into the global privileges that matter here. Pure,
 * so the self-check can drive it.
 */
export function mysqlRights(grants: string[]): { rights: string[]; missing: string[]; superuser: boolean } {
  const global = grants.filter((grant) => /\sON\s+\*\.\*\s/i.test(grant));
  const privileges = global.map((grant) => grant.replace(/^GRANT\s+/i, '').split(/\s+ON\s+/i)[0] ?? '');
  const all = privileges.some((list) => /\bALL(\s+PRIVILEGES)?\b/i.test(list));
  const has = (privilege: string) =>
    all || privileges.some((list) => list.split(',').some((p) => p.trim().toUpperCase() === privilege));
  const grantOption = global.some((grant) => /WITH GRANT OPTION/i.test(grant));

  const needed: Array<[string, boolean]> = [
    ['CREATE USER', has('CREATE USER')],
    ['CREATE', has('CREATE')],
    ['DROP', has('DROP')],
    ['GRANT OPTION', grantOption],
  ];
  const superuser = (all && grantOption) || has('SUPER');

  return {
    rights: [...needed.filter(([, ok]) => ok).map(([name]) => name), ...(superuser ? ['superuser'] : [])],
    missing: needed.filter(([, ok]) => !ok).map(([name]) => name),
    superuser,
  };
}

/** Version and admin rights — the connection test. Throws when the server cannot be reached or logged into. */
export async function inspect(dbs: DbServerRow): Promise<Inspection> {
  return withAdmin(dbs, async ({ query }) => {
    if (dbs.engine === 'POSTGRESQL') {
      const [versionRow] = await query('SHOW server_version');
      const [role] = await query(
        'SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user',
      );
      const superuser = !!role?.rolsuper;
      const needed: Array<[string, boolean]> = [
        ['CREATEROLE', superuser || !!role?.rolcreaterole],
        ['CREATEDB', superuser || !!role?.rolcreatedb],
      ];
      return {
        version: `PostgreSQL ${versionRow?.server_version ?? '?'}`,
        rights: [...needed.filter(([, ok]) => ok).map(([name]) => name), ...(superuser ? ['superuser'] : [])],
        missing: needed.filter(([, ok]) => !ok).map(([name]) => name),
        superuser,
      };
    }

    const [versionRow] = await query('SELECT VERSION() AS version');
    const grants = (await query('SHOW GRANTS FOR CURRENT_USER()')).map((row) => String(Object.values(row)[0]));
    const version = String(versionRow?.version ?? '?');
    return { version: `${/mariadb/i.test(version) ? 'MariaDB' : 'MySQL'} ${version}`, ...mysqlRights(grants) };
  });
}

/** Test one server and record the verdict. Never throws — an unreachable server is data. */
export async function checkDatabaseServer(
  dbs: DbServerRow,
): Promise<{ status: 'ONLINE' | 'OFFLINE'; inspection?: Inspection; error?: string }> {
  try {
    const inspection = await inspect(dbs);
    await prisma.databaseServer.update({
      where: { id: dbs.id },
      data: {
        status: 'ONLINE',
        version: inspection.version,
        adminRights: inspection.rights.join(','),
        lastSeenAt: new Date(),
        // reachable but unable to do its job is still worth a line on the page
        lastError: inspection.missing.length
          ? `The admin login is missing ${inspection.missing.join(', ')} — databases cannot be created until it is granted`
          : null,
      },
    });
    return { status: 'ONLINE', inspection };
  } catch (error: any) {
    const message = String(error?.message ?? error ?? 'connection failed').slice(0, 500);
    await prisma.databaseServer
      .update({ where: { id: dbs.id }, data: { status: 'OFFLINE', lastError: message } })
      .catch(() => {});
    return { status: 'OFFLINE', error: message };
  }
}

/** Every database server, for the health cron. */
export async function checkAllDatabaseServers(): Promise<{ total: number; online: number; offline: string[] }> {
  const servers = await prisma.databaseServer.findMany({ include: { server: true } });
  const offline: string[] = [];

  for (const dbs of servers) {
    const result = await checkDatabaseServer(dbs);
    if (result.status === 'OFFLINE') offline.push(dbs.name);
  }

  return { total: servers.length, online: servers.length - offline.length, offline };
}
