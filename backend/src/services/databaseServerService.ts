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
export async function reach<T>(dbs: DbServerRow, fn: (host: string, port: number) => Promise<T>): Promise<T> {
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
export function tlsOptions(dbs: DbServerRow): tls.ConnectionOptions | undefined {
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

/**
 * Try a database URL the way the app will use it: dialled from the app's own
 * node (through its SSH connection), logged in with the URL's credentials, one
 * `SELECT 1`. So `127.0.0.1` passes when the database shares that node and
 * fails when it does not — no guessing from the text of the URL.
 * TLS is attempted when the URL asks for it, without checking the certificate:
 * through the tunnel the name would not match, and this tests reachability and
 * login, not the chain.
 */
export async function testDatabaseUrl(node: SshTarget, raw: string): Promise<{ ok: boolean; message: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: 'Not a URL' };
  }
  const engine = /^postgres(ql)?:$/.test(url.protocol) ? 'POSTGRESQL' : /^mysql2?:$/.test(url.protocol) ? 'MYSQL' : null;
  if (!engine) return { ok: false, message: `Only PostgreSQL and MySQL URLs can be tested (${url.protocol.replace(':', '')})` };

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port) || (engine === 'POSTGRESQL' ? 5432 : 3306);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  // no database in the URL: the driver's default (the login's name / none)
  const inDatabase = database ? { database } : {};
  const wantsTls = /ssl(mode)?=(require|verify|true)|ssl-mode=(required|verify)/i.test(url.search);

  try {
    return await withTunnel(node, host, port, async (localPort) => {
      if (engine === 'POSTGRESQL') {
        const client = new PgClient({
          host: '127.0.0.1',
          port: localPort,
          user,
          password,
          ...inDatabase,
          ssl: wantsTls ? { rejectUnauthorized: false } : false,
          connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
          statement_timeout: QUERY_TIMEOUT_MS,
        });
        client.on('error', () => {});
        await client.connect();
        try {
          const [row] = (await client.query('SELECT current_user AS who, current_database() AS db')).rows;
          return { ok: true, message: `Connected as ${row.who} to ${row.db}` };
        } finally {
          await client.end().catch(() => {});
        }
      }
      const connection = await mysql.createConnection({
        host: '127.0.0.1',
        port: localPort,
        user,
        password,
        ...inDatabase,
        ...(wantsTls && { ssl: { rejectUnauthorized: false } }),
        connectTimeout: CONNECT_TIMEOUT_MS,
      });
      connection.on('error', () => {});
      try {
        const [rows] = await connection.query('SELECT CURRENT_USER() AS who, DATABASE() AS db');
        const row = (rows as any[])[0];
        return { ok: true, message: `Connected as ${row.who} to ${row.db}` };
      } finally {
        await connection.end().catch(() => {});
      }
    });
  } catch (error: any) {
    // the driver's reason, minus anything that echoes the password
    const reason = String(error?.message ?? error ?? 'connection failed').split(password || ' ').join('***');
    return { ok: false, message: `${host}:${port} from ${node.hostname}: ${reason}` };
  }
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

/** Every database server, for the health cron — and, for each that answers, its inventory. */
export async function checkAllDatabaseServers(): Promise<{ total: number; online: number; offline: string[] }> {
  const servers = await prisma.databaseServer.findMany({ include: { server: true } });
  const offline: string[] = [];

  for (const dbs of servers) {
    const result = await checkDatabaseServer(dbs);
    if (result.status === 'OFFLINE') {
      offline.push(dbs.name);
      continue;
    }
    await syncInventory(dbs).catch((error: any) =>
      console.error(`Could not sync the inventory of ${dbs.name}:`, error?.message),
    );
  }

  return { total: servers.length, online: servers.length - offline.length, offline };
}

// --- Inventory ---------------------------------------------------------------

/** Schemas and accounts every MySQL/MariaDB install has — never tenant data. */
const MYSQL_SYSTEM_SCHEMAS = ['mysql', 'information_schema', 'performance_schema', 'sys'];
const MYSQL_SYSTEM_USERS = ['mysql.sys', 'mysql.session', 'mysql.infoschema', 'mariadb.sys', 'debian-sys-maint'];

export interface Inventory {
  databases: Array<{ name: string; owner: string | null; sizeBytes: number | null }>;
  users: Array<{ username: string; host: string; canLogin: boolean; superuser: boolean; databases: string[] }>;
}

/**
 * Does a MySQL grant's database pattern cover a database name? `%` is any run,
 * `_` any one character, `\_` / `\%` literal — the rules mysql.db is written in.
 */
export function mysqlPatternMatches(pattern: string, name: string): boolean {
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '\\' && i + 1 < pattern.length) {
      regex += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (char === '%') regex += '.*';
    else if (char === '_') regex += '.';
    else regex += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${regex}$`).test(name);
}

/** What is on the server right now: its databases and its logins, and who can reach what. */
export async function readInventory(dbs: DbServerRow): Promise<Inventory> {
  return withAdmin(dbs, async ({ query }) => {
    if (dbs.engine === 'POSTGRESQL') {
      const databases = await query(`
        SELECT d.oid, d.datname AS name, pg_get_userbyid(d.datdba) AS owner,
               has_database_privilege(d.oid, 'CONNECT') AS can_connect
        FROM pg_database d
        WHERE NOT d.datistemplate AND d.datname <> 'postgres'
        ORDER BY 2`);
      // One statement per database: pg_database_size walks the files and can
      // take a second each on a busy box, so summed into one query a server
      // with many databases blows the statement timeout. A size that fails is
      // just unknown. Only where the admin may connect — it refuses otherwise.
      for (const row of databases) {
        if (!row.can_connect) continue;
        const [sized] = await query('SELECT pg_database_size($1::oid) AS size', [row.oid]).catch(() => [] as any[]);
        row.size = sized?.size ?? null;
      }
      // explicit CONNECT grants; grantee 0 is PUBLIC, which says nothing about anyone
      const grants = await query(`
        SELECT d.datname AS db, pg_get_userbyid(a.grantee) AS username
        FROM pg_database d, aclexplode(d.datacl) a
        WHERE a.grantee <> 0 AND a.privilege_type = 'CONNECT' AND NOT d.datistemplate`);
      const roles = await query(`
        SELECT rolname AS username, rolcanlogin AS can_login, rolsuper AS superuser
        FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1`);

      return {
        databases: databases.map((row) => ({
          name: String(row.name),
          owner: row.owner ? String(row.owner) : null,
          sizeBytes: row.size == null ? null : Number(row.size),
        })),
        users: roles.map((role) => {
          const username = String(role.username);
          const reach = new Set([
            ...databases.filter((row) => row.owner === username).map((row) => String(row.name)),
            ...grants.filter((row) => row.username === username).map((row) => String(row.db)),
          ]);
          return {
            username,
            host: '',
            canLogin: !!role.can_login,
            superuser: !!role.superuser,
            databases: [...reach].sort(),
          };
        }),
      };
    }

    const schemas = await query(
      `SELECT s.schema_name AS name, SUM(t.data_length + t.index_length) AS size
       FROM information_schema.schemata s
       LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name
       WHERE s.schema_name NOT IN (?)
       GROUP BY s.schema_name ORDER BY 1`,
      [MYSQL_SYSTEM_SCHEMAS],
    );
    const names = schemas.map((row) => String(row.name));

    // mysql.user / mysql.db need SELECT on the mysql schema; without it the
    // databases still sync and the user list is simply empty
    const accounts = await query('SELECT User AS username, Host AS host, Super_priv AS super FROM mysql.user').catch(
      () => [] as any[],
    );
    const dbGrants = await query('SELECT User AS username, Host AS host, Db AS db FROM mysql.db').catch(
      () => [] as any[],
    );

    return {
      databases: schemas.map((row) => ({
        name: String(row.name),
        owner: null,
        sizeBytes: row.size == null ? null : Number(row.size),
      })),
      users: accounts
        .filter((row) => row.username && !MYSQL_SYSTEM_USERS.includes(String(row.username)))
        .map((row) => {
          const username = String(row.username);
          const host = String(row.host ?? '');
          const patterns = dbGrants
            .filter((grant) => grant.username === username && grant.host === host)
            .map((grant) => String(grant.db));
          return {
            username,
            host,
            canLogin: true,
            superuser: String(row.super).toUpperCase() === 'Y',
            databases: names.filter((name) => patterns.some((pattern) => mysqlPatternMatches(pattern, name))).sort(),
          };
        }),
    };
  });
}

export interface SyncResult {
  databases: number;
  users: number;
  /** new databases found this time */
  created: number;
  /** databases the panel knew that are no longer on the server */
  missing: number;
}

/**
 * Mirror the server into the panel: every database becomes a row (new ones
 * unassigned, like apps from the app sync), and the login list is rewritten.
 * Re-runnable; never touches the server itself.
 */
export async function syncInventory(dbs: DbServerRow): Promise<SyncResult> {
  const inventory = await readInventory(dbs);
  const seenAt = new Date();

  for (const user of inventory.users) {
    const fields = {
      canLogin: user.canLogin,
      superuser: user.superuser,
      databases: user.databases,
      lastSeenAt: seenAt,
    };
    await prisma.databaseUser.upsert({
      where: {
        databaseServerId_username_host: { databaseServerId: dbs.id, username: user.username, host: user.host },
      },
      create: { databaseServerId: dbs.id, username: user.username, host: user.host, ...fields },
      update: fields,
    });
  }
  // a login dropped on the server drops out of the mirror
  await prisma.databaseUser.deleteMany({ where: { databaseServerId: dbs.id, lastSeenAt: { lt: seenAt } } });

  let created = 0;
  for (const database of inventory.databases) {
    const existing = await prisma.database.findFirst({
      where: { databaseServerId: dbs.id, dbName: database.name },
      select: { id: true },
    });
    if (existing) {
      await prisma.database.update({
        where: { id: existing.id },
        data: { sizeBytes: database.sizeBytes, status: 'RUNNING' },
      });
    } else {
      await prisma.database.create({
        data: {
          name: database.name,
          dbName: database.name,
          type: dbs.engine,
          status: 'RUNNING',
          discovered: true,
          databaseServerId: dbs.id,
          port: dbs.port,
          sizeBytes: database.sizeBytes,
        },
      });
      created++;
    }
  }

  // Gone from the server. An unassigned discovery just leaves the mirror; one
  // that an organization or app relies on stays, flagged, for someone to see.
  const gone = await prisma.database.findMany({
    where: { databaseServerId: dbs.id, dbName: { notIn: inventory.databases.map((database) => database.name) } },
    select: { id: true, discovered: true, organizationId: true, applicationId: true },
  });
  const drop = gone.filter((row) => row.discovered && !row.organizationId && !row.applicationId).map((row) => row.id);
  if (drop.length) await prisma.database.deleteMany({ where: { id: { in: drop } } });
  const flag = gone.filter((row) => !drop.includes(row.id)).map((row) => row.id);
  if (flag.length) await prisma.database.updateMany({ where: { id: { in: flag } }, data: { status: 'ERROR' } });

  return {
    databases: inventory.databases.length,
    users: inventory.users.length,
    created,
    missing: flag.length,
  };
}
