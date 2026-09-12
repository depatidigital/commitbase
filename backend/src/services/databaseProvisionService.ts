import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { decrypt, encrypt } from '../lib/secretBox';
import { withAdmin, type AdminSession, type DbServerRow } from './databaseServerService';

/**
 * Creating and dropping tenant databases, and the logins that reach them.
 *
 * An organization holds any number of logins on a server (OrgDatabaseAccount):
 * its default org_<slug>, and named ones like <slug>_shop — one per app, say.
 * A login reaches exactly the databases it was granted (DatabaseGrant), not
 * every database of the organization.
 *
 * PostgreSQL: a database is owned by its own NOLOGIN role (<db>_owner). Each
 * granted login is a member and, inside that database, acts as it (ALTER ROLE
 * … IN DATABASE … SET role) — so tables one login creates the others can use,
 * and membership reaches nothing else. Databases from before this are owned by
 * the org login (ownerRole null) and stay reachable by that login only.
 *
 * Login rows are written before the server is touched, so a retry — or two
 * creates racing — reuse one password. Every step is safe to repeat.
 */

/** A request the caller has to fix — a 400, not a server failure. */
export class ProvisionError extends Error {}

type Engine = 'POSTGRESQL' | 'MYSQL';

const CONNECTION_LIMIT = Math.max(1, Number(process.env.DB_ORG_CONNECTION_LIMIT) || 20);

/** What a tenant may call a database: the part after the org prefix. */
export const DB_NAME_RE = /^[a-z][a-z0-9_]{0,40}$/;
/** What a tenant may call a login: the part after the org prefix. */
export const LOGIN_NAME_RE = /^[a-z][a-z0-9_]{0,30}$/;

const maxIdent = (engine: Engine) => (engine === 'MYSQL' ? 32 : 63);
const shortHash = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);

/** org_<slug>, the organization's default login, inside the engine's name limit. Pure. */
export function loginName(slug: string, engine: Engine): string {
  const base = `org_${slug.replace(/-/g, '_')}`;
  const max = maxIdent(engine);
  if (base.length <= max) return base;
  // long slugs keep a readable head and a hash that stays unique per org
  const hash = shortHash(slug);
  return `${base.slice(0, max - hash.length - 1)}_${hash}`;
}

/** <slug>_<name> — a named login, prefixed so tenants cannot collide. Pure; throws ProvisionError. */
export function accountName(slug: string, name: string, engine: Engine): string {
  if (!LOGIN_NAME_RE.test(name)) {
    throw new ProvisionError('Login names use lowercase letters, digits and underscores, and start with a letter');
  }
  const full = `${slug.replace(/-/g, '_')}_${name}`;
  if (full.length > maxIdent(engine)) {
    throw new ProvisionError(`"${full}" is too long for ${engine === 'MYSQL' ? 'MySQL' : 'PostgreSQL'} — use a shorter login name`);
  }
  return full;
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

/** <db>_owner — the NOLOGIN role that owns a PostgreSQL database. Pure. */
export function ownerRoleName(dbName: string): string {
  const base = `${dbName}_owner`;
  if (base.length <= 63) return base;
  return `${dbName.slice(0, 63 - '_owner'.length - 9)}_${shortHash(dbName)}_owner`;
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

async function roleExists(session: AdminSession, dbs: DbServerRow, username: string): Promise<boolean> {
  const rows =
    dbs.engine === 'POSTGRESQL'
      ? await session.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [username])
      : await session.query('SELECT 1 FROM mysql.user WHERE user = ?', [username]);
  return rows.length > 0;
}

/** Which login to use: one the organization has, a new named one, or (neither) its default. */
export type LoginChoice = { accountId: string } | { username: string } | undefined;

/**
 * The login row for a choice, created (with a fresh password) when new. A new
 * name that already exists on the server but is not ours is refused — taking
 * it over would hand its password to this organization.
 */
export async function resolveAccount(
  dbs: DbServerRow,
  organization: { id: string; slug: string },
  login: LoginChoice,
) {
  if (login && 'accountId' in login) {
    const account = await prisma.orgDatabaseAccount.findFirst({
      where: { id: login.accountId, organizationId: organization.id, databaseServerId: dbs.id },
    });
    if (!account) throw new ProvisionError('That login does not belong to this organization on this server');
    return account;
  }

  const engine = dbs.engine as Engine;
  const username = login?.username ? accountName(organization.slug, login.username, engine) : loginName(organization.slug, engine);
  const existing = await prisma.orgDatabaseAccount.findUnique({
    where: { databaseServerId_username: { databaseServerId: dbs.id, username } },
  });
  if (existing) {
    if (existing.organizationId !== organization.id) throw new ProvisionError(`The login ${username} is taken on this server`);
    return existing;
  }

  // org_<slug> is the panel's own name; a named login could be anyone's
  if (login?.username && (await withAdmin(dbs, (session) => roleExists(session, dbs, username)))) {
    throw new ProvisionError(`A login named ${username} already exists on this server and is not managed by the panel`);
  }
  try {
    return await prisma.orgDatabaseAccount.create({
      data: {
        organizationId: organization.id,
        databaseServerId: dbs.id,
        username,
        passwordEnc: encrypt(crypto.randomBytes(24).toString('base64url')),
      },
    });
  } catch (error: any) {
    // two requests made it at once: the first one's row (and password) wins
    if (error?.code !== 'P2002') throw error;
    return prisma.orgDatabaseAccount.findUniqueOrThrow({
      where: { databaseServerId_username: { databaseServerId: dbs.id, username } },
    });
  }
}

/** Create the login if missing, or bring it back in line with the stored password. */
async function ensureLogin(session: AdminSession, dbs: DbServerRow, username: string, password: string) {
  if (dbs.engine === 'POSTGRESQL') {
    const verb = (await roleExists(session, dbs, username)) ? 'ALTER' : 'CREATE';
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
      grants: { include: { account: true }, orderBy: { createdAt: 'asc' } },
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
 * Give a login access to a database: the grant row, then the server catches up
 * (provisionDatabase applies every grant). A database from before per-database
 * owners is only reachable by the login that owns it.
 */
export async function grantAccess(databaseId: string, accountId: string): Promise<{ ok: boolean; error?: string }> {
  const db = await loadDatabase(databaseId);
  if (!db) throw new ProvisionError('Database not found');
  if (db.grants.some((grant) => grant.accountId === accountId)) return provisionDatabase(databaseId);

  if (db.databaseServer?.engine === 'POSTGRESQL' && !db.ownerRole && db.grants.length > 0) {
    throw new ProvisionError(
      `${db.dbName} was created before per-app logins — connect it with ${db.grants[0].account.username}`,
    );
  }
  await prisma.databaseGrant.upsert({
    where: { databaseId_accountId: { databaseId, accountId } },
    create: { databaseId, accountId },
    update: {},
  });
  return provisionDatabase(databaseId);
}

/**
 * Make the database exist on its server with every granted login able to use
 * it. Records the outcome on the row (RUNNING, or ERROR with the reason).
 */
export async function provisionDatabase(id: string): Promise<{ ok: boolean; error?: string }> {
  const db = await loadDatabase(id);
  if (!db) throw new ProvisionError('Database not found');
  const { dbs, dbName } = requireParts(db);
  if (db.grants.length === 0) throw new ProvisionError('No login has access to this database yet');

  try {
    const logins = db.grants.map(({ account }) => ({ username: account.username, password: decrypt(account.passwordEnc) }));

    await withAdmin(dbs, async (session) => {
      for (const login of logins) await ensureLogin(session, dbs, login.username, login.password);

      if (dbs.engine === 'POSTGRESQL') {
        // older databases are owned by the org login itself
        const owner = db.ownerRole ?? logins[0].username;
        if (db.ownerRole && !(await roleExists(session, dbs, owner))) {
          await session.query(`CREATE ROLE ${pgIdent(owner)} NOLOGIN`);
        }
        await session.query(`GRANT ${pgIdent(owner)} TO CURRENT_USER`).catch(() => {});

        const [existing] = await session.query(
          'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
          [dbName],
        );
        // a same-named database someone else made is theirs — never taken over
        if (existing && existing.owner !== owner) {
          throw new ProvisionError(`A database named ${dbName} already exists on this server and belongs to ${existing.owner}`);
        }
        if (!existing) await session.query(`CREATE DATABASE ${pgIdent(dbName)} OWNER ${pgIdent(owner)}`);
        // nobody but the granted logins may even connect
        await session.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${pgIdent(dbName)} FROM PUBLIC`);
        await session.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${pgIdent(dbName)} TO ${pgIdent(owner)}`);

        if (db.ownerRole) {
          for (const login of logins) {
            await session.query(`GRANT ${pgIdent(owner)} TO ${pgIdent(login.username)}`);
            // inside this database the login works as the owner role, so what it
            // creates belongs to the database, not to whichever login made it
            await session.query(
              `ALTER ROLE ${pgIdent(login.username)} IN DATABASE ${pgIdent(dbName)} SET role = ${pgLiteral(owner)}`,
            );
          }
        }
        return;
      }

      await session.query(
        `CREATE DATABASE IF NOT EXISTS ${myIdent(dbName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
      for (const login of logins) {
        await session.query(`GRANT ALL PRIVILEGES ON ${myIdent(dbName)}.* TO ?@'%'`, [login.username]);
      }
    });

    await prisma.database.update({
      where: { id },
      data: {
        status: 'RUNNING',
        lastError: null,
        port: dbs.port,
        connectionString: connectionUrl(dbs, logins[0].username, dbName),
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
 * Drop a database the panel created, with its owner role and every login that
 * reached nothing else. A database the sync found is someone else's data: it
 * is never dropped here. Throws on a server failure, leaving the row in place.
 */
export async function dropDatabase(id: string): Promise<void> {
  const db = await loadDatabase(id);
  if (!db) throw new ProvisionError('Database not found');
  if (db.discovered || !db.databaseServer || !db.dbName) return;
  const { dbs, dbName } = requireParts(db);

  // logins granted only this database go with it; the rest just lose the grant
  const orphans: typeof db.grants = [];
  for (const grant of db.grants) {
    const elsewhere = await prisma.databaseGrant.count({ where: { accountId: grant.accountId, databaseId: { not: id } } });
    if (!elsewhere) orphans.push(grant);
  }
  const kept = db.grants.filter((grant) => !orphans.includes(grant));

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
        for (const { account } of orphans) await session.query(`DROP ROLE IF EXISTS ${pgIdent(account.username)}`);
        // takes the remaining logins' membership with it
        if (db.ownerRole) await session.query(`DROP ROLE IF EXISTS ${pgIdent(db.ownerRole)}`);
        return;
      }

      await session.query(`DROP DATABASE IF EXISTS ${myIdent(dbName)}`);
      // MySQL keeps database-level grants after the database is gone
      for (const { account } of kept) {
        await session.query(`REVOKE ALL PRIVILEGES ON ${myIdent(dbName)}.* FROM ?@'%'`, [account.username]).catch(() => {});
      }
      for (const { account } of orphans) await session.query(`DROP USER IF EXISTS ?@'%'`, [account.username]);
    });
  } catch (error: any) {
    const message = String(error?.message ?? error ?? 'drop failed').slice(0, 500);
    await prisma.database.update({ where: { id }, data: { lastError: `Could not drop: ${message}` } }).catch(() => {});
    throw new Error(message);
  }

  if (orphans.length) {
    await prisma.orgDatabaseAccount.deleteMany({ where: { id: { in: orphans.map((grant) => grant.accountId) } } });
  }
}

/**
 * Full credentials for one granted login (the oldest when none is named) —
 * only for databases the panel created; the caller audits the read.
 */
export async function databaseCredentials(id: string, accountId?: string) {
  const db = await loadDatabase(id);
  if (!db) throw new ProvisionError('Database not found');
  if (db.discovered) {
    throw new ProvisionError('This database was imported from the server — its credentials live with whoever created it');
  }
  const { dbs, dbName } = requireParts(db);

  const grant = accountId ? db.grants.find((g) => g.accountId === accountId) : db.grants[0];
  if (!grant) throw new ProvisionError('That login has no access to this database — retry provisioning');

  const { username } = grant.account;
  const password = decrypt(grant.account.passwordEnc);
  return {
    engine: dbs.engine,
    host: dbs.appHost,
    port: dbs.port,
    database: dbName,
    username,
    password,
    tls: dbs.mode === 'DIRECT',
    url: connectionUrl(dbs, username, dbName, password),
  };
}
