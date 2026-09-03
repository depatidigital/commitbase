import { S3Client, PutObjectCommand, CreateBucketCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getCloudflareConfigFromDb } from './integrationConfigService';

/**
 * Static sites live in Cloudflare R2 — one bucket per app, served through
 * Cloudflare's CDN. Caddy proxies the app's hostname to the bucket's public
 * host, so the edge does the caching and R2 only sees misses.
 */

interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketPrefix: string;
}

export function getR2Config(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucketPrefix: process.env.R2_BUCKET_PREFIX || 'site-',
  };
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

export async function uploadSiteObject(bucket: string, key: string, body: Buffer): Promise<void> {
  const config = getR2Config();
  if (!config) {
    throw new Error('R2 is not configured');
  }

  await client(config).send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: CONTENT_TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream',
      CacheControl: cacheControlFor(key),
    })
  );
}

/**
 * Turn on the bucket's Cloudflare-managed public host (pub-xxxx.r2.dev) and
 * return it. That host is what Caddy proxies to; visitors never see it.
 */
async function enablePublicHost(bucket: string): Promise<string | null> {
  const config = getR2Config();
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
  const config = getR2Config();
  if (!config) {
    throw new Error('R2 is not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY');
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
        await walk(fullPath);
      } else if (entry.isFile()) {
        const key = path.relative(localDir, fullPath).split(path.sep).join('/');
        await uploadSiteObject(bucket, key, await fs.readFile(fullPath));
        count += 1;
      }
    }
  }

  await walk(localDir);
  return count;
}
