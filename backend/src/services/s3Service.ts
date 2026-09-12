import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

interface S3Config {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  rootDir: string;
}

function getS3Config(): S3Config | null {
  const endpoint = process.env.S3_ENDPOINT;
  const region = process.env.S3_REGION;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const bucket = process.env.S3_BUCKET_NAME;
  const rootDir = process.env.S3_ROOT_DIR || '';

  if (!endpoint || !region || !accessKeyId || !secretAccessKey || !bucket) {
    return null;
  }

  return {
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    bucket,
    rootDir,
  };
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export async function uploadObject(key: string, body: Buffer | string): Promise<void> {
  const config = getS3Config();
  if (!config) {
    return;
  }

  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
  });

  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: body,
    }),
  );
}

export async function downloadObjectToString(key: string, maxBytes?: number): Promise<string | null> {
  const config = getS3Config();
  if (!config) {
    return null;
  }

  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
  });

  const params: any = {
    Bucket: config.bucket,
    Key: key,
  };

  if (maxBytes && maxBytes > 0) {
    params.Range = `bytes=-${maxBytes}`;
  }

  try {
    const response = await client.send(new GetObjectCommand(params));
    if (!response.Body) {
      return null;
    }

    const bodyStream = response.Body as NodeJS.ReadableStream;
    return await streamToString(bodyStream);
  } catch (error) {
    console.error('Error downloading S3 object', error);
    return null;
  }
}

export function getBuildLogKey(applicationId: string, deploymentId: string): string | null {
  const config = getS3Config();
  if (!config) {
    return null;
  }

  const normalizedRoot = config.rootDir && !config.rootDir.endsWith('/') ? `${config.rootDir}/` : config.rootDir;
  return `${normalizedRoot}applications/${applicationId}/deployments/${deploymentId}/build.log`;
}

export function getBuildLogUrl(applicationId: string, deploymentId: string): string | null {
  const config = getS3Config();
  if (!config) {
    return null;
  }

  const key = getBuildLogKey(applicationId, deploymentId);
  if (!key) {
    return null;
  }

  const endpoint = config.endpoint.replace(/\/$/, '');
  return `${endpoint}/${config.bucket}/${key}`;
}

/** `body` is the log's content — the file may be on a node, so the caller reads it. */
export async function uploadBuildLog(body: Buffer | string, applicationId: string, deploymentId: string): Promise<void> {
  const key = getBuildLogKey(applicationId, deploymentId);
  if (!key) {
    return;
  }

  await uploadObject(key, body);
}

export async function getBuildLogPresignedUrl(applicationId: string, deploymentId: string, expiresInSeconds: number = 300): Promise<string | null> {
  const config = getS3Config();
  if (!config) {
    return null;
  }

  const key = getBuildLogKey(applicationId, deploymentId);
  if (!key) {
    return null;
  }

  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
  });

  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: key,
  });

  try {
    const url = await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
    return url;
  } catch (error) {
    console.error('Error generating presigned build log URL', error);
    return null;
  }
}

function getStaticSitePrefix(applicationId: string): string | null {
  const config = getS3Config();
  if (!config) {
    return null;
  }

  const normalizedRoot = config.rootDir && !config.rootDir.endsWith('/') ? `${config.rootDir}/` : config.rootDir;
  return `${normalizedRoot}sites/${applicationId}/`;
}

/** Where sites deployed before R2 still live. New sites go to R2 (r2Service). */
export function getStaticSiteBaseUrl(applicationId: string): string | null {
  const config = getS3Config();
  if (!config) {
    return null;
  }

  const prefix = getStaticSitePrefix(applicationId);
  if (!prefix) {
    return null;
  }

  const endpoint = config.endpoint.replace(/\/$/, '');
  return `${endpoint}/${config.bucket}/${prefix}`;
}
