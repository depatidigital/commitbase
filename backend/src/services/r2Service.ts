import {
  S3Client,
  PutObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { getCloudflareConfigFromDb, getR2ConfigFromDb } from './integrationConfigService';

/**
 * Static sites live in Cloudflare R2, served through Cloudflare's CDN. Caddy
 * proxies the app's hostname to the public host, so the edge does the caching
 * and R2 only sees misses. Two layouts:
 *
 * - shared bucket (set in the admin panel): every site is a folder,
 *   `<rootDir>/<domain>/`, in one bucket behind its custom domain. This is what
 *   a bucket-scoped key allows — it may not create buckets.
 * - bucket per site (env keys or the Cloudflare token): `site-<domain>`, each
 *   with its own r2.dev public host.
 *
 * Either way the app row stores `staticBucket` as `bucket` or `bucket/prefix`
 * (bucket names cannot hold a '/') and `staticOrigin` as `host` or
 * `host/prefix`, so sites made under the old layout keep working unchanged.
 */

interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketPrefix: string;
  /** shared layout: the one bucket, its public URL, the folder sites go under */
  bucket?: string | null;
  publicUrl?: string | null;
  rootDir?: string | null;
}

const bucketPrefix = () => process.env.R2_BUCKET_PREFIX || 'site-';

/**
 * R2's S3 credentials can be derived from a Cloudflare API token: the access
 * key id is the token's id, the secret is the SHA-256 of the token value
 * (developers.cloudflare.com/r2/api/tokens). So the Cloudflare integration's
 * token is enough — it needs "Workers R2 Storage: Edit" and "Account: Read".
 */
let derived: { token: string; config: R2Config } | null = null;

async function r2ConfigFromCloudflare(): Promise<R2Config | null> {
  const cloudflare = await getCloudflareConfigFromDb();
  if (!cloudflare?.apiToken) return null;
  if (derived?.token === cloudflare.apiToken) return derived.config;

  const call = async (pathname: string) => {
    const response = await fetch(`${cloudflare.apiBase}${pathname}`, {
      headers: { Authorization: `Bearer ${cloudflare.apiToken}` },
    });
    const payload: any = await response.json().catch(() => null);
    return response.ok && payload?.success ? payload.result : null;
  };

  const accountId = process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || (await call('/accounts'))?.[0]?.id;
  if (!accountId) return null;

  // user tokens verify at /user, account-owned tokens at /accounts/:id
  const token = (await call('/user/tokens/verify')) ?? (await call(`/accounts/${accountId}/tokens/verify`));
  if (!token?.id) return null;

  const config: R2Config = {
    accountId,
    accessKeyId: token.id,
    secretAccessKey: createHash('sha256').update(cloudflare.apiToken).digest('hex'),
    bucketPrefix: bucketPrefix(),
  };
  derived = { token: cloudflare.apiToken, config };
  return config;
}

/** The admin panel's R2 settings win, then R2_* env keys, then the Cloudflare integration's token. */
export async function getR2Config(): Promise<R2Config | null> {
  const panel = await getR2ConfigFromDb();
  if (panel) return { ...panel, bucketPrefix: bucketPrefix() };

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (accountId && accessKeyId && secretAccessKey) {
    return { accountId, accessKeyId, secretAccessKey, bucketPrefix: bucketPrefix() };
  }

  return r2ConfigFromCloudflare();
}

const client = (config: R2Config) =>
  new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

/** R2 bucket names: lowercase, 3-63 chars, letters/digits/hyphens only. */
export function bucketNameFor(config: R2Config, domain: string): string {
  const slug = domain
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return `${config.bucketPrefix}${slug}`.slice(0, 63).replace(/-$/, '');
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
};

/**
 * HTML must revalidate or a deploy never reaches visitors; everything else is
 * either content-hashed or cheap to re-fetch, so it can sit in the edge cache.
 */
function cacheControlFor(key: string): string {
  const ext = path.extname(key).toLowerCase();

  if (ext === '.html' || ext === '.htm' || key.endsWith('.json')) {
    return 'public, max-age=0, s-maxage=60, must-revalidate';
  }

  return 'public, max-age=31536000, immutable';
}

/**
 * Buckets are public. A site published straight from a repository or a picked
 * folder would otherwise hand out .git/, .env and node_modules/ to anyone.
 */
export const isPublishable = (key: string): boolean =>
  key.split('/').every((part) => part !== 'node_modules' && (!part.startsWith('.') || part === '.well-known'));

/** Can the configured key reach its shared bucket? null when fine, else why not. */
export async function checkR2Access(): Promise<string | null> {
  const config = await getR2Config();
  if (!config) return 'R2 is not configured';
  if (!config.bucket) return null;
  try {
    await client(config).send(new HeadBucketCommand({ Bucket: config.bucket }));
    return null;
  } catch (error: any) {
    const status = error?.$metadata?.httpStatusCode;
    return status === 403
      ? `The key may not read bucket "${config.bucket}" — give it Object Read & Write on that bucket`
      : status === 404
        ? `Bucket "${config.bucket}" does not exist in account ${config.accountId}`
        : error?.message || 'Could not reach R2';
  }
}

/**
 * A stored `staticBucket` → the bucket and the key prefix of the site's folder
 * in it ('' for a bucket of its own). The prefix ends in '/', so listing
 * `larika/a.com/` never matches `larika/a.com.evil/`.
 */
export function siteLocation(stored: string): { bucket: string; prefix: string } {
  const slash = stored.indexOf('/');
  if (slash < 0) return { bucket: stored, prefix: '' };
  const prefix = stored.slice(slash + 1).replace(/\/+$/, '');
  // an empty folder would make "replace the whole site" empty the shared bucket
  if (!prefix) throw new Error(`Refusing site location "${stored}": no folder inside the shared bucket`);
  return { bucket: stored.slice(0, slash), prefix: prefix + '/' };
}

/** Returns false, uploading nothing, for a path that must stay private. */
export async function uploadSiteObject(bucket: string, key: string, body: Buffer): Promise<boolean> {
  if (!isPublishable(key)) return false;

  const config = await getR2Config();
  if (!config) {
    throw new Error('R2 is not configured');
  }

  const site = siteLocation(bucket);
  await client(config).send(
    new PutObjectCommand({
      Bucket: site.bucket,
      Key: site.prefix + key,
      Body: body,
      ContentType: CONTENT_TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream',
      CacheControl: cacheControlFor(key),
    })
  );
  return true;
}

/**
 * Turn on the bucket's Cloudflare-managed public host (pub-xxxx.r2.dev) and
 * return it. That host is what Caddy proxies to; visitors never see it.
 */
async function enablePublicHost(bucket: string): Promise<string | null> {
  const config = await getR2Config();
  const cloudflare = await getCloudflareConfigFromDb();

  if (!config || !cloudflare?.apiToken) {
    return null;
  }

  const url = `${cloudflare.apiBase}/accounts/${config.accountId}/r2/buckets/${bucket}/domains/managed`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${cloudflare.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ enabled: true }),
  });

  const payload: any = await response.json().catch(() => null);
  const domain = payload?.result?.domain;

  if (!response.ok || !domain) {
    throw new Error(
      payload?.errors?.map((e: any) => e?.message).filter(Boolean).join('; ') ||
        `Cloudflare rejected the public host request (HTTP ${response.status})`
    );
  }

  return domain;
}

/**
 * Make sure the app has a bucket with a public host, creating both the first
 * time. Returns what Caddy and the database need to point at it.
 */
export async function ensureSiteBucket(domain: string): Promise<{ bucket: string; origin: string }> {
  const config = await getR2Config();
  if (!config) {
    throw new Error(
      'R2 is not configured — give the Cloudflare integration token "Workers R2 Storage: Edit" and "Account: Read", or set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY'
    );
  }

  if (config.bucket) {
    const host = (config.publicUrl || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!host) {
      throw new Error('R2 shared bucket has no public URL — set it in the admin panel (the custom domain on the bucket)');
    }
    const folder = [(config.rootDir || '').trim().replace(/^\/+|\/+$/g, ''), domain.trim().toLowerCase()]
      .filter(Boolean)
      .join('/');
    return { bucket: `${config.bucket}/${folder}`, origin: `${host}/${folder}` };
  }

  const bucket = bucketNameFor(config, domain);

  try {
    await client(config).send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (error: any) {
    const code = error?.name || error?.Code;
    // a redeploy reuses the bucket it made last time
    if (code !== 'BucketAlreadyOwnedByYou' && code !== 'BucketAlreadyExists') {
      throw error;
    }
  }

  const origin = await enablePublicHost(bucket);
  if (!origin) {
    throw new Error('Could not enable the public host for the site bucket — check the Cloudflare API token has R2 edit access');
  }

  return { bucket, origin };
}

/** Push a built site directory into its bucket, keeping the folder layout. */
export async function uploadSiteDirectory(bucket: string, localDir: string): Promise<number> {
  let count = 0;

  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        // don't even descend into .git / node_modules
        if (isPublishable(entry.name)) await walk(fullPath);
      } else if (entry.isFile()) {
        const key = path.relative(localDir, fullPath).split(path.sep).join('/');
        if (await uploadSiteObject(bucket, key, await fs.readFile(fullPath))) count += 1;
      }
    }
  }

  await walk(localDir);
  return count;
}

export type SiteObject = { key: string; size: number; lastModified: string | null };

/** Every object in a site bucket. ponytail: no cap — a static site is thousands of files, not millions. */
export async function listSiteObjects(bucket: string): Promise<SiteObject[]> {
  const config = await getR2Config();
  if (!config) throw new Error('R2 is not configured');

  const site = siteLocation(bucket);
  const objects: SiteObject[] = [];
  let token: string | undefined;
  do {
    const page = await client(config).send(
      new ListObjectsV2Command({ Bucket: site.bucket, Prefix: site.prefix || undefined, ContinuationToken: token })
    );
    for (const item of page.Contents ?? []) {
      if (item.Key) {
        objects.push({
          key: item.Key.slice(site.prefix.length),
          size: item.Size ?? 0,
          lastModified: item.LastModified?.toISOString() ?? null,
        });
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  return objects;
}

/**
 * Copy objects between two site locations inside R2, keeping their content
 * type and cache headers. No bytes pass through here. Returns how many copied.
 * ponytail: one request per object — fine for a site's thousands of files.
 */
export async function copySiteObjects(from: string, to: string, keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const config = await getR2Config();
  if (!config) throw new Error('R2 is not configured');

  const source = siteLocation(from);
  const target = siteLocation(to);
  const r2 = client(config);
  for (const key of keys) {
    await r2.send(
      new CopyObjectCommand({
        Bucket: target.bucket,
        Key: target.prefix + key,
        CopySource: `${source.bucket}/${(source.prefix + key).split('/').map(encodeURIComponent).join('/')}`,
      }),
    );
  }
  return keys.length;
}

/** Delete objects, 1000 per request (the S3 limit). Returns how many went. */
export async function deleteSiteObjects(bucket: string, keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const config = await getR2Config();
  if (!config) throw new Error('R2 is not configured');

  const site = siteLocation(bucket);
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const result = await client(config).send(
      new DeleteObjectsCommand({
        Bucket: site.bucket,
        Delete: { Objects: batch.map((key) => ({ Key: site.prefix + key })), Quiet: true },
      })
    );
    deleted += batch.length - (result.Errors?.length ?? 0);
  }
  return deleted;
}
