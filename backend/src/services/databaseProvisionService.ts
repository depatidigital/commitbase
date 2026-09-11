import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { decrypt, encrypt } from '../lib/secretBox';
import { withAdmin, type AdminSession, type DbServerRow } from './databaseServerService';

/**
 * Creating and dropping tenant databases, and the organization's login they
 * belong to.
 *
 * One login per organization per database server (org_<slug>), owning every
 * database the organization has there. The login row is written before the
 * server is touched, so a retry — or two creates racing — reuse one password
 * instead of each minting its own. Every step is safe to repeat: a create that
 * died halfway is finished by the next attempt, not duplicated.
 */

/** A request the caller has to fix — a 400, not a server failure. */
export class ProvisionError extends Error {}

type Engine = 'POSTGRESQL' | 'MYSQL';

const CONNECTION_LIMIT = Math.max(1, Number(process.env.DB_ORG_CONNECTION_LIMIT) || 20);

/** What a tenant may call a database: the part after the org prefix. */
export const DB_NAME_RE = /^[a-z][a-z0-9_]{0,40}$/;

/** org_<slug>, inside the engine's name limit (MySQL: 32). Pure. */
export function loginName(slug: string, engine: Engine): string {
  const base = `org_${slug.replace(/-/g, '_')}`;
  const max = engine === 'MYSQL' ? 32 : 63;
  if (base.length <= max) return base;
  // long slugs keep a readable head and a hash that stays unique per org
  const hash = crypto.createHash('sha256').update(slug).digest('hex').slice(0, 8);
  return `${base.slice(0, max - hash.length - 1)}_${hash}`;
}

/** <slug>_<name> — the real name on the server, prefixed so tenants cannot collide. Pure; throws ProvisionError. */
export function databaseName(slug: string, name: string, engine: Engine): string {
  if (!DB_NAME_RE.test(name)) {
    throw new ProvisionError('Database names use lowercase letters, digits and underscores, and start with a letter');
  }
  const full = `${slug.replace(/-/g, '_')}_${name}`;
  if (full.length > (engine === 'MYSQL' ? 64 : 63)) {
    throw new ProvisionError(`"${full}" is too long for ${engine === 'MYSQL' ? 'MySQL' : 'PostgreSQL'} — use a shorter name`);
  }
  return full;
}

// Identifiers are already restricted by the patterns above; quoting them is
// the second fence, not the first.
const pgIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
const pgLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;
const myIdent = (name: string) => `\`${name.replace(/`/g, '``')}\``;

/** The URL an app connects with. Without a password it is safe to store and show. */
export function connectionUrl(
  dbs: Pick<DbServerRow, 'engine' | 'mode' | 'appHost' | 'port'>,
  username: string,
  database: string,
  password?: string,
): string {
  const scheme = dbs.engine === 'POSTGRESQL' ? 'postgresql' : 'mysql';
  const auth = `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ''}`;
  // a managed server is reached over networks we do not own — the app must use TLS too
  const tls = dbs.mode === 'DIRECT' ? (dbs.engine === 'POSTGRESQL' ? '?sslmode=require' : '?ssl-mode=REQUIRED') : '';
  return `${scheme}://${auth}@${dbs.appHost}:${dbs.port}/${encodeURIComponent(database)}${tls}`;
}

/**
 * The organization's login on this server: the stored one, or a new one. The
 * row is created first and re-read, so concurrent callers share one password.
 */
async function orgAccount(dbs: DbServerRow, organization: { id: string; slug: string }) {
  const account = await prisma.orgDatabaseAccount.upsert({
    where: { organizationId_databaseServerId: { organizationId: organization.id, databaseServerId: dbs.id } },
    create: {
      organizationId: organization.id,
      databaseServerId: dbs.id,
      username: loginName(organization.slug, dbs.engine as Engine),
      passwordEnc: encrypt(crypto.randomBytes(24).toString('base64url')),
    },
    update: {},
  });
  return { username: account.username, password: decrypt(account.passwordEnc) };
}

/** Create the login if missing, or bring it back in line with the stored password. */
async function ensureLogin(session: AdminSession, dbs: DbServerRow, username: string, password: string) {
  if (dbs.engine === 'POSTGRESQL') {
    const [exists] = await session.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [username]);
    const verb = exists ? 'ALTER' : 'CREATE';
    await session.query(
      `${verb} ROLE ${pgIdent(username)} LOGIN PASSWORD ${pgLiteral(password)} CONNECTION LIMIT ${CONNECTION_LIMIT}`,
    );
    // CREATE DATABASE … OWNER needs the admin to be able to act as that role
    // (PostgreSQL 16 no longer lets CREATEROLE imply it). Already a member, or
    // a superuser, is fine — anything real surfaces on the CREATE DATABASE.
    await session.query(`GRANT ${pgIdent(username)} TO CURRENT_USER`).catch(() => {});
    return;
  }

  // ponytail: host '%' — the server's bind address and firewall are the fence
  // (loopback/private for a node, TLS-only for a managed service). Pin the
  // account to the app nodes' addresses if a server ever listens publicly.
  const requireTls = dbs.mode === 'DIRECT' ? ' REQUIRE SSL' : '';
  await session.query(
    `CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?${requireTls} WITH MAX_USER_CONNECTIONS ${CONNECTION_LIMIT}`,
    [username, password],
  );
  await session.query(`ALTER USER ?@'%' IDENTIFIED BY ?`, [username, password]);
}

type DatabaseRow = NonNullable<Awaited<ReturnType<typeof loadDatabase>>>;

function loadDatabase(id: string) {
  return prisma.database.findUnique({
    where: { id },
    include: {
      databaseServer: { include: { server: true } },
      organization: { select: { id: true, slug: true } },
    },
  });
}

function requireParts(db: DatabaseRow) {
  if (!db.databaseServer || !db.organization || !db.dbName) {
    throw new ProvisionError('This database has no server, organization or name to provision with');
  }
  return { dbs: db.databaseServer, organization: db.organization, dbName: db.dbName };
}

/**
 * Make the database exist on its server, owned by the org's login. Records the
 * outcome on the row (RUNNING, or ERROR with the reason) and returns it.
 */
export async function provisionDatabase(id: string): Promise<{ ok: boolean; error?: string }> {
  const db = await loadDatabase(id);
  if (!db) throw new ProvisionError('Database not found');
  const { dbs, organization, dbName } = requireParts(db);

  try {
    const account = await orgAccount(dbs, organization);

    await withAdmin(dbs, async (session) => {
      await ensureLogin(session, dbs, account.username, account.password);

      if (dbs.engine === 'POSTGRESQL') {
        const [existing] = await session.query(
          'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
          [dbName],
        );
        // a same-named database someone else made is theirs — never taken over
        if (existing && existing.owner !== account.username) {
          throw new ProvisionError(`A database named ${dbName} already exists on this server and belongs to ${existing.owner}`);
        }
        if (!existing) await session.query(`CREATE DATABASE ${pgIdent(dbName)} OWNER ${pgIdent(account.username)}`);
        // nobody but the org's login may even connect
        await session.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${pgIdent(dbName)} FROM PUBLIC`);
        await session.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${pgIdent(dbName)} TO ${pgIdent(account.username)}`);
        return;
      }

      await session.query(
        `CREATE DATABASE IF NOT EXISTS ${myIdent(dbName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
      await session.query(`GRANT ALL PRIVILEGES ON ${myIdent(dbName)}.* TO ?@'%'`, [account.username]);
    });

    await prisma.database.update({
      where: { id },
      data: {
        status: 'RUNNING',
        lastError: null,
        port: dbs.port,
        connectionString: connectionUrl(dbs, account.username, dbName),
      },
    });
    return { ok: true };
  } catch (error: any) {
    const message = String(error?.message ?? error ?? 'provisioning failed').slice(0, 500);
    await prisma.database.update({ where: { id }, data: { status: 'ERROR', lastError: message } }).catch(() => {});
    if (error instanceof ProvisionError) throw error;
    return { ok: false, error: message };
  }
}

/**
 * Drop a database the panel created, and the org's login with its last one.
 * A database the sync found is someone else's data: it is never dropped here.
 * Throws on a server failure, leaving the row in place with the reason.
 */
export async function dropDatabase(id: string): Promise<void> {
  const db = await loadDatabase(id);
  if (!db) throw new ProvisionError('Database not found');
  if (db.discovered || !db.databaseServer || !db.dbName) return;
  const { dbs, organization, dbName } = requireParts(db);

  const account = await prisma.orgDatabaseAccount.findUnique({
    where: { organizationId_databaseServerId: { organizationId: organization.id, databaseServerId: dbs.id } },
  });
  // the last database this org created there takes the login with it
  const remaining = await prisma.database.count({
    where: { organizationId: organization.id, databaseServerId: dbs.id, discovered: false, id: { not: id } },
  });

  try {
    await withAdmin(dbs, async (session) => {
      if (dbs.engine === 'POSTGRESQL') {
        // FORCE (PostgreSQL 13+) ends the app's open connections; older servers refuse while any are open
        await session
          .query(`DROP DATABASE IF EXISTS ${pgIdent(dbName)} WITH (FORCE)`)
          .catch(async (error: any) => {
            if (error?.code !== '42601') throw error;
            await session.query(`DROP DATABASE IF EXISTS ${pgIdent(dbName)}`);
          });
        if (account && !remaining) await session.query(`DROP ROLE IF EXISTS ${pgIdent(account.username)}`);
        return;
      }

      await session.query(`DROP DATABASE IF EXISTS ${myIdent(dbName)}`);
      if (account && !remaining) await session.query(`DROP USER IF EXISTS ?@'%'`, [account.username]);
    });
  } catch (error: any) {
    const message = String(error?.message ?? error ?? 'drop failed').slice(0, 500);
    await prisma.database.update({ where: { id }, data: { lastError: `Could not drop: ${message}` } }).catch(() => {});
    throw new Error(message);
  }

  if (account && !remaining) await prisma.orgDatabaseAccount.delete({ where: { id: account.id } });
}

/** The full credentials — only for databases the panel created; the caller audits the read. */
export async function databaseCredentials(id: string) {
  const db = await loadDatabase(id);
  if (!db) throw new ProvisionError('Database not found');
  if (db.discovered) {
    throw new ProvisionError('This database was imported from the server — its credentials live with whoever created it');
  }
  const { dbs, organization, dbName } = requireParts(db);

  const account = await prisma.orgDatabaseAccount.findUnique({
    where: { organizationId_databaseServerId: { organizationId: organization.id, databaseServerId: dbs.id } },
  });
  if (!account) throw new ProvisionError('The organization has no login on this server yet — retry provisioning');

  const password = decrypt(account.passwordEnc);
  return {
    engine: dbs.engine,
    host: dbs.appHost,
    port: dbs.port,
    database: dbName,
    username: account.username,
    password,
    tls: dbs.mode === 'DIRECT',
    url: connectionUrl(dbs, account.username, dbName, password),
  };
}
