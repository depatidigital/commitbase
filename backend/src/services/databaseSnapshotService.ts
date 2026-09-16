import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { prisma } from '../lib/prisma';
import { buildCommand, connect } from '../lib/runner';
import { deletePrivateObjects, getPrivateObject, listPrivateObjects, putPrivateObject } from './r2Service';
import { databaseCredentials } from './databaseProvisionService';
import { MYSQLDUMP, PG_DUMP } from './databaseBackupService';
import { ImportError, releaseImport, reserveImport, runImport } from './databaseImportService';

/**
 * A database as it was just before a deploy ran its pre-deploy step (the
 * migrations): dumped to R2's private bucket as .sql.gz, the same file Restore
 * takes. Migrations only go forward, so this is the way back when one goes
 * wrong — put back on its own for an app that had nothing live yet, offered
 * on the deploy's history row for one that had (its live release kept writing
 * while the build ran; what came in since is gone with a restore).
 *
 * ponytail: the newest KEEP per database, named by when and for which deploy —
 * the object listing is the index. A row per snapshot if they ever need more than a name.
 */

const KEEP = Math.max(1, Number(process.env.DB_SNAPSHOT_KEEP) || 5);
const FILE = /^(\d{8}-\d{6})-([A-Za-z0-9_-]+)\.sql\.gz$/;

export type Snapshot = { databaseId: string; file: string; deploymentId: string; createdAt: Date; bytes: number };

const prefixOf = (databaseId: string) => `db-snapshots/${databaseId}/`;
/** `20260915-101844-<deployment id>.sql.gz` — sorts by time, says which deploy */
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

/** A database's snapshots, newest first. Pure over the object listing. */
export async function listSnapshots(databaseId: string): Promise<Snapshot[]> {
  const objects = await listPrivateObjects(prefixOf(databaseId)).catch(() => []);
  const out: Snapshot[] = [];
  for (const { key: file, size } of objects) {
    const match = file.match(FILE);
    if (!match) continue;
    const [, at, deploymentId] = match;
    const createdAt = new Date(`${at!.slice(0, 4)}-${at!.slice(4, 6)}-${at!.slice(6, 8)}T${at!.slice(9, 11)}:${at!.slice(11, 13)}:${at!.slice(13, 15)}Z`);
    out.push({ databaseId, file, deploymentId: deploymentId!, createdAt, bytes: size });
  }
  return out.sort((a, b) => b.file.localeCompare(a.file));
}

/** The snapshots taken for one deploy, across the app's databases. */
export async function snapshotsOfDeployment(deploymentId: string, databaseIds: string[]): Promise<Snapshot[]> {
  const all = await Promise.all(databaseIds.map(listSnapshots));
  return all.flat().filter((s) => s.deploymentId === deploymentId);
}

/**
 * Dump the database to a snapshot object, as its own login on its node (like a
 * backup download). Throws when it cannot: a managed service has no node of
 * ours to run the tools on. Prunes older snapshots past KEEP.
 * Spooled through a temp file: S3 wants the length up front, gzip cannot say it.
 */
export async function snapshotDatabase(databaseId: string, deploymentId: string): Promise<Snapshot> {
  const db = await prisma.database.findUnique({ where: { id: databaseId }, include: { databaseServer: { include: { server: true } } } });
  const dbs = db?.databaseServer;
  if (!db?.dbName || !dbs) throw new ImportError('This database has no server to snapshot from');
  if (dbs.mode !== 'TUNNEL' || !dbs.server) throw new ImportError(`${dbs.name} is a managed service — its provider keeps the backups`);
  const { username, password } = await databaseCredentials(databaseId);

  const file = `${stamp()}-${deploymentId}.sql.gz`;
  const partial = path.join(os.tmpdir(), `larika-snapshot-${databaseId}-${Date.now()}.part`);

  const script = dbs.engine === 'POSTGRESQL' ? PG_DUMP : MYSQLDUMP;
  const command = buildCommand(['bash', '-c', script, 'bash', dbs.host, String(dbs.port), username, db.dbName]);
  const client = await connect(dbs.server);
  await new Promise<void>((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(new Error(`SSH exec on ${dbs.server!.hostname} failed: ${err.message}`));
      let stderr = '';
      let bytes = 0;
      const gzip = zlib.createGzip();
      const out = fs.createWriteStream(partial, { mode: 0o600 });
      gzip.pipe(out);
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-4000);
      });
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (!gzip.write(chunk)) {
          stream.pause();
          gzip.once('drain', () => stream.resume());
        }
      });
      stream.end(`${password}\n`);
      stream.on('close', (code: number | null) => {
        gzip.end();
        out.on('finish', () => {
          if (code === 0 && bytes > 0) resolve();
          else reject(new Error(bytes === 0 ? 'the dump came back empty' : stderr.trim().split('\n').slice(-3).join('\n') || `exited ${code}`));
        });
      });
    });
  }).catch(async (error) => {
    await fs.promises.unlink(partial).catch(() => {});
    throw error;
  });
  const bytes = (await fs.promises.stat(partial)).size;
  try {
    await putPrivateObject(prefixOf(databaseId) + file, fs.createReadStream(partial), bytes);
  } finally {
    await fs.promises.unlink(partial).catch(() => {});
  }

  // the newest KEEP stay
  const old = (await listSnapshots(databaseId)).slice(KEEP);
  await deletePrivateObjects(old.map((s) => prefixOf(databaseId) + s.file)).catch(() => {});
  return { databaseId, file, deploymentId, createdAt: new Date(), bytes };
}

/**
 * Put a snapshot back: an import of its file (a copy — the import deletes what
 * it runs), as the database's own login, followed on the Database tab like any
 * import. Answers with the import row as it starts — or, `wait`, once it has
 * finished. null when an import is already running there.
 */
export async function restoreSnapshot(databaseId: string, file: string, userId: string, { wait = false } = {}) {
  if (!FILE.test(file)) throw new ImportError('Not a snapshot');
  const source = await getPrivateObject(prefixOf(databaseId) + file).catch(() => null);
  if (!source) throw new ImportError('That snapshot is gone');
  if (!reserveImport(databaseId)) {
    source.destroy();
    return null;
  }
  let row;
  const copy = path.join(os.tmpdir(), `larika-snapshot-${databaseId}-${Date.now()}.sql.gz`);
  try {
    await pipeline(source, fs.createWriteStream(copy, { mode: 0o600 }));
    row = await prisma.databaseImport.create({
      data: { databaseId, userId, fileName: `snapshot ${file}`, sizeBytes: (await fs.promises.stat(copy)).size },
    });
  } catch (error) {
    releaseImport(databaseId);
    await fs.promises.unlink(copy).catch(() => {});
    throw error;
  }
  // releases the database and deletes the copy when done
  // the panel's own dump (--clean): over the data that came since, so emptied first
  const run = runImport(row.id, databaseId, copy, { reset: true });
  if (!wait) return row;
  await run;
  return prisma.databaseImport.findUnique({ where: { id: row.id } });
}
