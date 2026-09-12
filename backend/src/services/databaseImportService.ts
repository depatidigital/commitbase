import crypto from 'crypto';
import fs from 'fs';
import { PassThrough, Transform, pipeline, type Readable } from 'stream';
import { once } from 'events';
import { finished } from 'stream/promises';
import zlib from 'zlib';
import { StringDecoder } from 'string_decoder';
import { Client as PgClient } from 'pg';
import { from as copyFrom, type CopyStreamQuery } from 'pg-copy-streams';
import mysql from 'mysql2/promise';
import { prisma } from '../lib/prisma';
import { liveLog } from '../lib/liveLog';
import { buildCommand, connect, getSftp } from '../lib/runner';
import { reach, tlsOptions } from './databaseServerService';
import { databaseCredentials } from './databaseProvisionService';

/**
 * Running an uploaded .sql file (optionally gzipped) against one database.
 *
 * It runs as the database's own login, never the server's admin: that login can
 * reach this database and nothing else, so a dump that says `USE other_db` or
 * `DROP DATABASE x` is refused by the server itself, whatever gets past the
 * checks here.
 *
 * Statements go through the drivers one at a time — never through `psql` or
 * `mysql` on a node, which would run `\!` shell escapes, `\copy` from node
 * files and friends out of a tenant's upload. PostgreSQL runs in one
 * transaction (a failure leaves the database as it was); MySQL cannot roll
 * back DDL, so a failure there leaves what ran so far.
 */

type Engine = 'POSTGRESQL' | 'MYSQL';

/** The file or its contents are the problem — shown to the user as is. */
export class ImportError extends Error {}

const COPY_CHUNK = 256 * 1024;
const STATEMENT_TIMEOUT_MS = 15 * 60_000;

export type SqlEvent =
  | { type: 'statement'; sql: string; line: number }
  | { type: 'meta'; command: string; line: number }
  | { type: 'copy'; sql: string; line: number }
  | { type: 'data'; text: string }
  | { type: 'copyEnd' };

/**
 * Cuts a dump into statements, a line at a time, without ever holding more
 * than one statement (or one COPY chunk). Knows enough of each dialect to not
 * split inside strings, quoted names, comments and PostgreSQL $tag$ bodies,
 * plus MySQL's DELIMITER and pg_dump's inline `COPY … FROM stdin` data.
 * Lines keep their \r: it matters inside strings, and COPY accepts \r\n.
 */
export class SqlSplitter {
  private buf = '';
  private start = 1;
  private lineNo = 0;
  /** closing token of the quote we're in: ' " ` or a $tag$ */
  private quote: string | null = null;
  private escapes = false;
  private blockDepth = 0;
  private delimiter = ';';
  private copying = false;
  private copyBuf = '';
  /** pg: old dumps turn this off, and then every '…' takes backslash escapes */
  private conformingStrings = true;

  constructor(private engine: Engine) {}

  pushLine(line: string): SqlEvent[] {
    this.lineNo++;
    const out: SqlEvent[] = [];

    if (this.copying) {
      if (line.trimEnd() === '\\.') {
        if (this.copyBuf) out.push({ type: 'data', text: this.copyBuf });
        this.copyBuf = '';
        this.copying = false;
        out.push({ type: 'copyEnd' });
      } else {
        this.copyBuf += `${line}\n`;
        if (this.copyBuf.length >= COPY_CHUNK) {
          out.push({ type: 'data', text: this.copyBuf });
          this.copyBuf = '';
        }
      }
      return out;
    }

    const idle = !this.buf.trim() && !this.quote && !this.blockDepth;
    if (idle) {
      this.buf = '';
      this.start = this.lineNo;
      const trimmed = line.trim();
      if (!trimmed || (this.engine === 'POSTGRESQL' ? /^--/ : /^(--(\s|$)|#)/).test(trimmed)) return out;
      if (this.engine === 'POSTGRESQL' && trimmed.startsWith('\\')) {
        out.push({ type: 'meta', command: trimmed, line: this.lineNo });
        return out;
      }
      const delimiter = this.engine === 'MYSQL' && /^DELIMITER\s+(\S+)$/i.exec(trimmed);
      if (delimiter) {
        this.delimiter = delimiter[1]!;
        return out;
      }
    }

    this.scan(line, out);
    return out;
  }

  /** Whatever is left once the file ends. Throws ImportError when the file stops mid-string or mid-COPY. */
  end(): SqlEvent[] {
    if (this.copying) throw new ImportError('The file ends inside COPY data (the closing \\. line is missing) — is it complete?');
    if (this.quote || this.blockDepth) {
      throw new ImportError(`The file ends inside an unclosed ${this.quote ? 'string' : 'comment'} that starts near line ${this.start} — is it complete?`);
    }
    const out: SqlEvent[] = [];
    this.emit(out);
    return out;
  }

  private emit(out: SqlEvent[]) {
    const sql = this.buf.trim();
    this.buf = '';
    if (!sql) return;
    if (this.engine === 'POSTGRESQL' && /^COPY\s[\s\S]*\bFROM\s+stdin\b/i.test(sql)) {
      out.push({ type: 'copy', sql, line: this.start });
      this.copying = true;
      return;
    }
    if (this.engine === 'POSTGRESQL' && /^SET\s+standard_conforming_strings\s*(=|TO)\s*'?(on|off)/i.test(sql)) {
      this.conformingStrings = /\b'?on'?\s*$/i.test(sql);
    }
    out.push({ type: 'statement', sql, line: this.start });
  }

  private scan(line: string, out: SqlEvent[]) {
    const pg = this.engine === 'POSTGRESQL';
    let from = 0;
    let i = 0;
    while (i < line.length) {
      const c = line[i]!;

      if (this.quote) {
        if (this.escapes && c === '\\') i += 2;
        else if (line.startsWith(this.quote, i)) {
          i += this.quote.length;
          this.quote = null;
        } else i++;
        continue;
      }
      if (this.blockDepth) {
        if (line.startsWith('*/', i)) {
          this.blockDepth--;
          i += 2;
        } else if (pg && line.startsWith('/*', i)) {
          // PostgreSQL block comments nest; MySQL's don't
          this.blockDepth++;
          i += 2;
        } else i++;
        continue;
      }

      if (line.startsWith(this.delimiter, i)) {
        this.buf += line.slice(from, i);
        this.emit(out);
        i += this.delimiter.length;
        from = i;
        // the rest of a COPY line is not SQL
        if (this.copying) return;
        this.start = this.lineNo;
        continue;
      }
      // a line comment: dropped, so it never counts as the start of a statement
      if (c === '-' && line[i + 1] === '-' && (pg || i + 2 >= line.length || /\s/.test(line[i + 2]!))) break;
      if (c === '#' && !pg) break;

      if (c === '/' && line[i + 1] === '*') {
        this.blockDepth = 1;
        i += 2;
      } else if (c === "'") {
        // pg: E'…' (or everything, with standard_conforming_strings off) takes backslash escapes
        this.quote = "'";
        this.escapes = !pg || !this.conformingStrings || /(^|[^A-Za-z0-9_])[Ee]$/.test(line.slice(Math.max(0, i - 2), i));
        i++;
      } else if (c === '"') {
        this.quote = '"';
        this.escapes = !pg;
        i++;
      } else if (c === '`' && !pg) {
        this.quote = '`';
        this.escapes = false;
        i++;
      } else if (c === '$' && pg && !/[A-Za-z0-9_$]/.test(line[i - 1] ?? '')) {
        const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(line.slice(i, i + 64));
        this.quote = tag ? tag[0] : null;
        this.escapes = false;
        i += tag ? tag[0].length : 1;
      } else i++;
    }

    const rest = i >= line.length ? line.slice(from) : line.slice(from, i);
    this.buf += rest;
    // a newline only means something inside a statement (or a string)
    if (this.buf.trim() || this.quote || this.blockDepth) this.buf += '\n';
    else this.buf = '';
  }
}

/** Statements that fail as a tenant for no fault of the data, and change nothing an app needs. */
const SKIP: Record<Engine, RegExp[]> = {
  POSTGRESQL: [
    // everything is owned by the database's owner role anyway
    /^ALTER\s+[\s\S]+\s+OWNER\s+TO\s/i,
    /^SET\s+(SESSION\s+AUTHORIZATION|ROLE)\b/i,
    // the source's roles do not exist here, and every login here acts as the owner
    /^(GRANT|REVOKE)\s/i,
    /^ALTER\s+DEFAULT\s+PRIVILEGES\s/i,
    /^COMMENT\s+ON\s+EXTENSION\s/i,
    // pg_dump 17 writes it; older servers do not know it
    /^SET\s+transaction_timeout\b/i,
  ],
  MYSQL: [
    // replication settings: need SUPER, mean nothing to one database
    /^SET\s+@@GLOBAL\.GTID_PURGED/i,
    /^SET\s+@@SESSION\.SQL_LOG_BIN\s*=/i,
  ],
};

const stripComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
const unquote = (name: string) => name.replace(/^[`"]|[`"]$/g, '');

/**
 * What to do with one statement: run it, or skip it (noise a tenant cannot
 * run). Throws ImportError for a dump aimed at another database — the server
 * would refuse it too, this just says why in words.
 */
export function plan(engine: Engine, sql: string, dbName: string): 'run' | 'skip' {
  if (SKIP[engine].some((re) => re.test(sql))) return 'skip';
  const bare = stripComments(sql);

  if (/^DROP\s+(DATABASE|SCHEMA)\s/i.test(bare) && (engine === 'MYSQL' || /^DROP\s+DATABASE/i.test(bare))) {
    throw new ImportError('The file drops a database — an import only adds to this one. Remove the DROP DATABASE line.');
  }
  if (engine === 'POSTGRESQL' && /^(CREATE|ALTER)\s+DATABASE\s/i.test(bare)) {
    throw new ImportError(`The file creates or changes a database itself — export one database without -C/--create, it is imported into ${dbName}.`);
  }
  if (engine === 'MYSQL') {
    const use = /^USE\s+(`[^`]+`|\S+)$/i.exec(bare);
    const create = /^CREATE\s+(?:DATABASE|SCHEMA)\s+(?:IF\s+NOT\s+EXISTS\s+)?(`[^`]+`|[^\s;]+)/i.exec(bare);
    const named = use?.[1] ?? create?.[1];
    if (named) {
      if (unquote(named) === dbName) return 'skip';
      throw new ImportError(
        `The file switches to database ${unquote(named)} — it can only be imported into ${dbName}. Export without --databases, or remove its USE / CREATE DATABASE lines.`,
      );
    }
  }
  return 'run';
}

/** A psql backslash command: pg_dump's \restrict pair is skipped, anything else stops the import. */
export function planMeta(command: string, dbName: string): 'skip' {
  if (/^\\(un)?restrict\b/.test(command)) return 'skip';
  if (/^\\c(onnect)?\b/.test(command)) {
    throw new ImportError(`The file switches databases (${command}) — export one database without -C/--create, it is imported into ${dbName}.`);
  }
  throw new ImportError(`${command.split(/\s/)[0]} is a psql command, not SQL, and is never run here — remove it from the file.`);
}

/** MySQL: DEFINER=`someone`@`host` needs SUPER unless it is us — drop it, the object is then ours. */
export function prepare(engine: Engine, sql: string): string {
  if (engine !== 'MYSQL' || /^INSERT\s/i.test(sql) || !/DEFINER\s*=/i.test(sql)) return sql;
  return sql.replace(/DEFINER\s*=\s*(?:`[^`]*`|'[^']*'|\w+(?:\(\))?)(?:\s*@\s*(?:`[^`]*`|'[^']*'|[\w.%-]+))?/gi, '');
}

/** Which engine a dump was made for, from its first bytes. Null when it does not say. */
export function sniffEngine(head: string): Engine | null {
  if (/PostgreSQL database dump|^\\restrict\s|pg_catalog\./m.test(head)) return 'POSTGRESQL';
  if (/(MySQL|MariaDB) dump|^\/\*!\d{5}/im.test(head)) return 'MYSQL';
  return null;
}

// ---------------------------------------------------------------------------

interface Session {
  engine: Engine;
  dbName: string;
  username: string;
  query: (sql: string) => Promise<any[]>;
  /** PostgreSQL only */
  copyFrom?: (sql: string) => CopyStreamQuery;
}

/** A connection to the database as its own (first) login, reached the way the admin session is. */
async function withTenant<T>(databaseId: string, fn: (session: Session) => Promise<T>): Promise<T> {
  const db = await prisma.database.findUnique({
    where: { id: databaseId },
    include: { databaseServer: { include: { server: true } } },
  });
  if (!db?.databaseServer || !db.dbName) throw new ImportError('This database has no server to import into');
  const dbs = db.databaseServer;
  const dbName = db.dbName;
  const engine = dbs.engine as Engine;
  // throws for a discovered database: we do not hold its password
  const { username, password } = await databaseCredentials(databaseId);
  const ssl = tlsOptions(dbs);

  return reach(dbs, async (host, port) => {
    if (engine === 'POSTGRESQL') {
      const client = new PgClient({
        host,
        port,
        user: username,
        password,
        database: dbName,
        ssl: ssl ?? false,
        connectionTimeoutMillis: 10_000,
        statement_timeout: STATEMENT_TIMEOUT_MS,
        application_name: 'panel-import',
      });
      client.on('error', () => {});
      await client.connect();
      try {
        return await fn({
          engine,
          dbName,
          username,
          query: async (sql) => (await client.query(sql)).rows ?? [],
          copyFrom: (sql) => client.query(copyFrom(sql)),
        });
      } finally {
        // ends an unfinished transaction too — PostgreSQL rolls it back
        await client.end().catch(() => {});
      }
    }

    const connection = await mysql.createConnection({
      host,
      port,
      user: username,
      password,
      database: dbName,
      ...(ssl && { ssl: ssl as any }),
      connectTimeout: 10_000,
      // a dump saying LOAD DATA LOCAL INFILE must not get to read the panel's files
      flags: ['-LOCAL_FILES'],
      multipleStatements: false,
    });
    connection.on('error', () => {});
    try {
      return await fn({
        engine,
        dbName,
        username,
        query: async (sql) => {
          const [rows] = await connection.query({ sql, timeout: STATEMENT_TIMEOUT_MS });
          return Array.isArray(rows) ? rows : [];
        },
      });
    } finally {
      await connection.end().catch(() => {});
    }
  });
}

/** How many tables the database has — an import into a non-empty one is confirmed by name. */
export async function tableCount(databaseId: string): Promise<number> {
  return withTenant(databaseId, async (session) => {
    const [row] = await session.query(
      session.engine === 'POSTGRESQL'
        ? "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')"
        : 'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()',
    );
    return Number(row?.n ?? 0);
  });
}

// ponytail: in-process lock — one backend instance. A shared lock (a unique
// partial index on RUNNING rows) when the API runs more than one.
const running = new Set<string>();

/** Hold the database for one import. False when one is already running. */
export function reserveImport(databaseId: string): boolean {
  if (running.has(databaseId)) return false;
  running.add(databaseId);
  return true;
}

export function releaseImport(databaseId: string) {
  running.delete(databaseId);
}

export const importRunning = (databaseId: string) => running.has(databaseId);

/** A database's latest imports. A RUNNING row nobody is running is one a restart cut short. */
export async function listImports(databaseId: string) {
  if (!running.has(databaseId)) {
    await prisma.databaseImport.updateMany({
      where: { databaseId, status: 'RUNNING' },
      data: { status: 'FAILED', error: 'Interrupted — the panel restarted during the import', finishedAt: new Date() },
    });
  }
  return prisma.databaseImport.findMany({
    where: { databaseId },
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: { user: { select: { id: true, name: true, email: true } } },
  });
}

/**
 * A pg_dump custom-format archive (-Fc, what DBeaver's "Backup" writes) as a
 * plain SQL script: uploaded to the database's node and turned into SQL there
 * by `pg_restore -f -`, which only reads the archive — it connects to nothing
 * and runs nothing. The script then goes through the same path as any .sql.
 * The node has the server's own client tools, so its pg_restore can read
 * archives from that version.
 */
async function archiveToScript(databaseId: string, filePath: string, importId: string) {
  const db = await prisma.database.findUnique({
    where: { id: databaseId },
    include: { databaseServer: { include: { server: true } } },
  });
  const dbs = db?.databaseServer;
  if (dbs?.engine !== 'POSTGRESQL') throw new ImportError('This is a PostgreSQL backup archive — it cannot go into a MySQL database.');
  if (dbs.mode !== 'TUNNEL' || !dbs.server) {
    throw new ImportError('Backup archives can only be restored on our own database servers — export as plain SQL instead.');
  }
  const node = dbs.server;
  const remote = `/tmp/larika-restore-${importId}.dump`;

  const sftp = await getSftp(node);
  await new Promise<void>((resolve, reject) =>
    sftp.fastPut(filePath, remote, { mode: 0o600 }, (error) => (error ? reject(new Error(`Upload to ${node.hostname} failed: ${error.message}`)) : resolve())),
  );
  const script = new PassThrough();
  // ends pg_restore if the import stopped before reading it all, then removes the copy
  const cleanup = () => {
    script.destroy();
    return new Promise<void>((resolve) => sftp.unlink(remote, () => resolve()));
  };

  const client = await connect(node);
  client.exec(buildCommand(['pg_restore', '--no-owner', '--no-privileges', '--clean', '--if-exists', '-f', '-', remote]), (error, channel) => {
    if (error) {
      script.destroy(new Error(`SSH exec on ${node.hostname} failed: ${error.message}`));
      return;
    }
    let stderr = '';
    channel.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000);
    });
    channel.pipe(script, { end: false });
    channel.on('close', (code: number | null) => {
      if (code === 0) script.end();
      else script.destroy(new ImportError(`The archive could not be read: ${stderr.trim() || `pg_restore exited ${code}`}`));
    });
    // the import stopped reading (it failed): stop pg_restore too
    script.on('close', () => channel.close());
  });
  return { script, cleanup };
}

/** PostgreSQL text cannot hold NUL — a dump (or an error quoting it) can. */
const clean = (text: string) => text.replace(/\u0000/g, '');

const errorText = (error: any) =>
  [error?.message ?? String(error), error?.detail, error?.hint && `Hint: ${error.hint}`, error?.where]
    .filter(Boolean)
    .join('\n');

/**
 * Run the uploaded file at `filePath` for import row `importId`. Never throws:
 * the outcome lands on the row. Deletes the file and releases the database's
 * lock when done.
 */
export async function runImport(importId: string, databaseId: string, filePath: string): Promise<void> {
  const live = liveLog((text) => prisma.databaseImport.update({ where: { id: importId }, data: { log: clean(text) } }));
  /** The outcome, recorded no matter what: a lost write leaves the row RUNNING and the dialog waiting forever. */
  const finish = async (data: { status: 'DONE' | 'FAILED'; error?: string; sha256?: string }) => {
    const outcome = { ...data, ...(data.error && { error: clean(data.error) }), statements, skipped, finishedAt: new Date() };
    try {
      await prisma.databaseImport.update({ where: { id: importId }, data: { ...outcome, log: clean(live.text) } });
    } catch (error) {
      console.error(`Import ${importId}: could not record the result`, error);
      await prisma.databaseImport
        .update({ where: { id: importId }, data: { status: data.status, error: 'The result could not be recorded — see the panel log', finishedAt: new Date() } })
        .catch((again) => console.error(`Import ${importId}: could not record the result at all`, again));
    }
  };
  const started = Date.now();
  const hash = crypto.createHash('sha256');
  let statements = 0;
  let skipped = 0;
  let line = 0;
  // the archive's copy on the node, when one was uploaded
  let removeRemote: (() => Promise<void>) | null = null;
  const database = await prisma.database
    .findUnique({ where: { id: databaseId }, select: { applicationId: true, dbName: true } })
    .catch(() => null);
  const row = await prisma.databaseImport.findUnique({ where: { id: importId } }).catch(() => null);

  try {
    const size = (await fs.promises.stat(filePath)).size;
    const handle = await fs.promises.open(filePath, 'r');
    const magic = Buffer.alloc(5);
    await handle.read(magic, 0, 5, 0);
    await handle.close();
    const gzipped = magic[0] === 0x1f && magic[1] === 0x8b;
    // pg_dump -Fc (DBeaver's backups): binary, turned into SQL on the node first
    const archive = magic.toString('latin1') === 'PGDMP';

    const raw = fs.createReadStream(filePath);
    const tap = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const noop = () => {};
    let text: Readable;
    if (archive) {
      for await (const chunk of raw) hash.update(chunk as Buffer);
      live.push('Reading the backup archive…\n');
      const converted = await archiveToScript(databaseId, filePath, importId);
      removeRemote = converted.cleanup;
      text = converted.script;
    } else {
      text = gzipped ? pipeline(raw, tap, zlib.createGunzip(), noop) : pipeline(raw, tap, noop);
    }

    await withTenant(databaseId, async (session) => {
      const { engine, dbName } = session;
      const kind = archive ? ' (backup archive)' : gzipped ? ' (gzip)' : '';
      live.push(`Importing ${row?.fileName ?? 'file'}${kind} into ${dbName} as ${session.username}\n`);
      if (engine === 'POSTGRESQL') {
        await session.query('BEGIN');
        live.push('Running in one transaction — nothing is kept unless everything succeeds\n');
      }

      const splitter = new SqlSplitter(engine);
      let copy: CopyStreamQuery | null = null;
      let copyLine = 0;
      let lastProgress = Date.now();

      const run = async (events: SqlEvent[]) => {
        for (const event of events) {
          if (event.type === 'meta') {
            planMeta(event.command, dbName);
            skipped++;
          } else if (event.type === 'statement') {
            if (plan(engine, event.sql, dbName) === 'skip') {
              skipped++;
              continue;
            }
            try {
              await session.query(prepare(engine, event.sql));
            } catch (error) {
              throw new ImportError(`Line ${event.line}: ${errorText(error)}\n\n${event.sql.slice(0, 300)}`);
            }
            statements++;
          } else if (event.type === 'copy') {
            copy = session.copyFrom!(event.sql);
            copyLine = event.line;
            // kept until end(): an early error surfaces on the next write or on finished()
            copy.on('error', noop);
            statements++;
          } else if (event.type === 'data') {
            try {
              // a stream that already failed never drains — surface its error instead of waiting
              if (copy!.errored) throw copy!.errored;
              if (!copy!.write(event.text)) await once(copy!, 'drain');
            } catch (error) {
              throw new ImportError(`COPY at line ${copyLine}: ${errorText(error)}`);
            }
          } else {
            try {
              copy!.end();
              await finished(copy!);
            } catch (error) {
              throw new ImportError(`COPY at line ${copyLine}: ${errorText(error)}`);
            }
            copy = null;
          }
        }
      };

      let rest = '';
      let decoder: StringDecoder | null = null;
      for await (const bytes of text as AsyncIterable<Buffer>) {
        let chunk: string;
        if (decoder) chunk = decoder.write(bytes);
        else {
          // the encoding, from the first bytes: UTF-8 (with or without a BOM) or
          // UTF-16LE — what PowerShell's `>` writes
          let body = bytes;
          if (bytes[0] === 0xff && bytes[1] === 0xfe) {
            decoder = new StringDecoder('utf16le');
            body = bytes.subarray(2);
          } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
            throw new ImportError('The file is UTF-16 (big-endian) — save it as UTF-8 and try again.');
          } else {
            decoder = new StringDecoder('utf8');
            if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) body = bytes.subarray(3);
          }
          chunk = decoder.write(body);
          const madeFor = sniffEngine(chunk.slice(0, 64 * 1024));
          if (madeFor && madeFor !== engine) {
            throw new ImportError(
              `This is a ${madeFor === 'MYSQL' ? 'MySQL' : 'PostgreSQL'} dump and ${dbName} is ${engine === 'MYSQL' ? 'MySQL' : 'PostgreSQL'} — nothing was run.`,
            );
          }
        }
        const lines = (rest + chunk).split('\n');
        rest = lines.pop()!;
        for (const current of lines) {
          line++;
          await run(splitter.pushLine(current));
        }
        if (Date.now() - lastProgress > 5_000) {
          lastProgress = Date.now();
          // an archive's SQL has no known length — no percentage for it
          const percent = !archive && size ? `${Math.min(99, Math.floor((raw.bytesRead / size) * 100))}% · ` : '';
          live.push(`${percent}line ${line.toLocaleString('en')} · ${statements.toLocaleString('en')} statements\n`);
        }
      }
      // a character cut at the very end of the file
      rest += decoder?.end() ?? '';
      if (rest) {
        line++;
        await run(splitter.pushLine(rest));
      }
      await run(splitter.end());

      if (engine === 'POSTGRESQL') await session.query('COMMIT');
    });

    const seconds = Math.round((Date.now() - started) / 1000);
    live.push(`Done: ${statements.toLocaleString('en')} statements in ${seconds}s${skipped ? `, ${skipped} skipped (owners, grants and other settings a tenant cannot set)` : ''}\n`);
    await live.stop();
    await finish({ status: 'DONE', sha256: hash.digest('hex') });
    if (row) {
      await prisma.log.create({
        data: {
          level: 'INFO',
          message: `Imported ${row.fileName} into database ${database?.dbName} (${statements} statements)`,
          userId: row.userId,
          applicationId: database?.applicationId ?? null,
          metadata: { databaseId, importId, statements, skipped, seconds },
        },
      }).catch(() => {});
    }
  } catch (error: any) {
    const message = (error instanceof ImportError ? error.message : errorText(error)).slice(0, 4000);
    if (!(error instanceof ImportError)) console.error(`Import ${importId} failed:`, error);
    live.push(`\nFailed: ${message}\n`);
    await live.stop();
    await finish({ status: 'FAILED', error: message });
    if (row) {
      await prisma.log.create({
        data: {
          level: 'ERROR',
          message: `Import of ${row.fileName} into database ${database?.dbName} failed`,
          userId: row.userId,
          applicationId: database?.applicationId ?? null,
          metadata: { databaseId, importId, error: clean(message.slice(0, 500)) },
        },
      }).catch(() => {});
    }
  } finally {
    releaseImport(databaseId);
    await fs.promises.unlink(filePath).catch(() => {});
    await removeRemote?.();
  }
}
