import * as fs from 'fs/promises';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

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

export async function uploadBuildLog(buildLogPath: string, applicationId: string, deploymentId: string): Promise<void> {
  const key = getBuildLogKey(applicationId, deploymentId);
  if (!key) {
    return;
  }

  const body = await fs.readFile(buildLogPath);
  await uploadObject(key, body);
}
