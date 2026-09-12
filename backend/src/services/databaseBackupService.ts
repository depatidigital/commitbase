import zlib from 'zlib';
import type { Response } from 'express';
import { prisma } from '../lib/prisma';
import { buildCommand, connect } from '../lib/runner';
import { databaseCredentials } from './databaseProvisionService';
import { ImportError } from './databaseImportService';

/**
 * A backup of one database, streamed to the browser as .sql.gz — the same
 * format Restore takes back.
 *
 * pg_dump / mysqldump run on the database's own node (where the server's
 * client tools already are, matching its version), as the database's own
 * login, so the dump holds this database and nothing else. The password goes
 * in on stdin and lives in a shell variable: never in argv, never in a file.
 * PostgreSQL dumps drop what they recreate (--clean), so restoring one over
 * the same database replaces it rather than colliding with it.
 *
 * ponytail: tunnelled servers only — a managed service has no node of ours to
 * run the tools on. Its provider's backups cover it.
 */

const PG_DUMP =
  'IFS= read -r pw; PGPASSWORD="$pw" exec pg_dump --no-owner --no-privileges --clean --if-exists -h "$1" -p "$2" -U "$3" -d "$4" </dev/null';
// the password reaches mysqldump as an option file on a pipe — MYSQL_PWD is deprecated.
// ponytail: unescaped inside "…" — panel passwords are base64url, never a quote or backslash
const MYSQLDUMP =
  'IFS= read -r pw; exec mysqldump --defaults-extra-file=<(printf \'[client]\\npassword="%s"\\n\' "$pw") --protocol=TCP --single-transaction --routines --triggers --no-tablespaces -h "$1" -P "$2" -u "$3" "$4" </dev/null';

/** Stream the backup into `res`. Errors before the first byte are answered as JSON; after it, the download is cut off. */
export async function streamBackup(databaseId: string, userId: string, res: Response, signal: AbortSignal): Promise<void> {
  const db = await prisma.database.findUnique({
    where: { id: databaseId },
    include: { databaseServer: { include: { server: true } } },
  });
  const dbs = db?.databaseServer;
  if (!db?.dbName || !dbs) throw new ImportError('This database has no server to back up from');
  if (dbs.mode !== 'TUNNEL' || !dbs.server) {
    throw new ImportError(`${dbs.name} is a managed service — use its provider's backups`);
  }
  const { username, password } = await databaseCredentials(databaseId);

  const script = dbs.engine === 'POSTGRESQL' ? PG_DUMP : MYSQLDUMP;
  const command = buildCommand(['bash', '-c', script, 'bash', dbs.host, String(dbs.port), username, db.dbName]);
  const client = await connect(dbs.server);
  const started = Date.now();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const fileName = `${db.dbName}-${stamp}.sql.gz`;

  await new Promise<void>((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(new Error(`SSH exec on ${dbs.server!.hostname} failed: ${err.message}`));

      let stderr = '';
      let bytes = 0;
      let gzip: zlib.Gzip | null = null;
      const stop = () => {
        try {
          stream.signal('TERM');
        } catch {
          // no signal support: closing still ends it
        }
        stream.close();
      };
      signal.addEventListener('abort', stop, { once: true });

      stream.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-4000);
      });
      stream.on('data', (chunk: Buffer) => {
        if (!gzip) {
          // the first byte: from here on it is a download
          res.setHeader('Content-Type', 'application/gzip');
          res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
          gzip = zlib.createGzip();
          gzip.pipe(res);
        }
        bytes += chunk.length;
        if (!gzip.write(chunk)) {
          stream.pause();
          gzip.once('drain', () => stream.resume());
        }
      });
      stream.end(`${password}\n`);

      stream.on('close', async (code: number | null) => {
        signal.removeEventListener('abort', stop);
        const ok = code === 0 && !signal.aborted;
        await prisma.log
          .create({
            data: {
              level: ok ? 'INFO' : 'ERROR',
              message: ok ? `Backup of database ${db.dbName} downloaded` : `Backup of database ${db.dbName} failed`,
              userId,
              applicationId: db.applicationId,
              metadata: { databaseId, bytes, seconds: Math.round((Date.now() - started) / 1000), ...(!ok && { error: stderr.slice(-500) }) },
            },
          })
          .catch(() => {});

        if (ok) {
          if (gzip) gzip.end();
          else res.status(502).json({ success: false, error: 'The dump came back empty' });
          return resolve();
        }
        const reason = stderr.trim().split('\n').slice(-3).join('\n') || `exited ${code}`;
        // a half-written file must not look like a finished one
        if (gzip) res.destroy(new Error(reason));
        else if (!signal.aborted) res.status(502).json({ success: false, error: `Backup failed: ${reason}` });
        resolve();
      });
    });
  });
}
