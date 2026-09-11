import { S3Client, PutObjectCommand, CreateBucketCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
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

/** Dedicated R2_* env keys win; otherwise fall back to the Cloudflare integration's token. */
export async function getR2Config(): Promise<R2Config | null> {
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

/** Returns false, uploading nothing, for a path that must stay private. */
export async function uploadSiteObject(bucket: string, key: string, body: Buffer): Promise<boolean> {
  if (!isPublishable(key)) return false;

  const config = await getR2Config();
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
