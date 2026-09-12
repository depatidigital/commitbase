import { prisma } from '../lib/prisma';
import { decrypt } from '../lib/secretBox';

const RDASH_PROVIDER = 'rdash';
const CLOUDFLARE_PROVIDER = 'cloudflare';
const R2_PROVIDER = 'r2';

type Provider = typeof RDASH_PROVIDER | typeof CLOUDFLARE_PROVIDER | typeof R2_PROVIDER;

export async function getIntegrationConfigValue(provider: Provider, key: string): Promise<string | null> {
  const entry = await prisma.integrationConfig.findUnique({
    where: {
      provider_key: {
        provider,
        key,
      },
    },
  });
  if (!entry) {
    return null;
  }

  return entry.value;
}

export async function setIntegrationConfigValue(provider: Provider, key: string, value: string): Promise<void> {
  await prisma.integrationConfig.upsert({
    where: {
      provider_key: {
        provider,
        key,
      },
    },
    create: {
      provider,
      key,
      value,
    },
    update: {
      value,
    },
  });
}

export async function getRdashConfigFromDb() {
  const [resellerId, apiKey, baseUrl] = await Promise.all([
    getIntegrationConfigValue(RDASH_PROVIDER, 'resellerId'),
    getIntegrationConfigValue(RDASH_PROVIDER, 'apiKey'),
    getIntegrationConfigValue(RDASH_PROVIDER, 'baseUrl'),
  ]);

  if (!resellerId || !apiKey) {
    return null;
  }

  return {
    resellerId,
    apiKey,
    baseUrl: baseUrl || 'https://api.rdash.id/v1',
  };
}

export async function getCloudflareConfigFromDb() {
  const [apiToken, zoneId, dnsTarget, apiBase] = await Promise.all([
    getIntegrationConfigValue(CLOUDFLARE_PROVIDER, 'apiToken'),
    getIntegrationConfigValue(CLOUDFLARE_PROVIDER, 'zoneId'),
    getIntegrationConfigValue(CLOUDFLARE_PROVIDER, 'dnsTarget'),
    getIntegrationConfigValue(CLOUDFLARE_PROVIDER, 'apiBase'),
  ]);

  if (!apiToken) {
    return null;
  }

  return {
    apiToken,
    zoneId: zoneId || null,
    dnsTarget: dnsTarget || null,
    apiBase: apiBase || 'https://api.cloudflare.com/client/v4',
  };
}

export const R2_KEYS = ['accountId', 'accessKeyId', 'secretAccessKey', 'bucket', 'publicUrl', 'rootDir'] as const;
export type R2Key = (typeof R2_KEYS)[number];

/** R2 as set in the admin panel; null until the three credentials are there. The secret is stored secretBox-encrypted. */
export async function getR2ConfigFromDb() {
  const values = await Promise.all(R2_KEYS.map((key) => getIntegrationConfigValue(R2_PROVIDER, key)));
  const [accountId, accessKeyId, secret, bucket, publicUrl, rootDir] = values;
  if (!accountId || !accessKeyId || !secret) return null;

  return {
    accountId,
    accessKeyId,
    secretAccessKey: decrypt(secret),
    bucket: bucket || null,
    publicUrl: publicUrl || null,
    rootDir: rootDir || null,
  };
}

export const setR2ConfigValue = (key: R2Key, value: string) => setIntegrationConfigValue(R2_PROVIDER, key, value);
