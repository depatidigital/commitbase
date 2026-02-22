import { prisma } from '../lib/prisma';

const RDASH_PROVIDER = 'rdash';
const CLOUDFLARE_PROVIDER = 'cloudflare';

type Provider = typeof RDASH_PROVIDER | typeof CLOUDFLARE_PROVIDER;

export async function getIntegrationConfigValue(provider: Provider, key: string): Promise<string | null> {
  const entry = await prisma.integrationConfig.findUnique({
    where: {
      provider_key: {
        provider,
        key,
      },
    },
  });
  console.log('Integration config:', entry);
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
