import { getCloudflareNameservers } from './cloudflareService';
import { getRdashConfigFromDb } from './integrationConfigService';

interface RdashConfig {
  baseUrl: string;
  resellerId: string;
  apiKey: string;
}

function getAuthHeader(config: RdashConfig): string {
  const credentials = Buffer.from(`${config.resellerId}:${config.apiKey}`).toString('base64');
  return `Basic ${credentials}`;
}

export async function getRdashNameservers(): Promise<string[]> {
  const candidates = [
    process.env.CLOUDFLARE_NS1,
    process.env.CLOUDFLARE_NS2,
    process.env.CLOUDFLARE_NS3,
    process.env.CLOUDFLARE_NS4,
  ];

  const envNameservers = candidates
    .map(value => (value || '').trim())
    .filter(value => value.length > 0);

  if (envNameservers.length > 0) {
    return envNameservers;
  }

  const apiNameservers = await getCloudflareNameservers();
  if (apiNameservers && apiNameservers.length > 0) {
    return apiNameservers;
  }

  return [];
}

function getDomainRegisterPath(): string {
  return '/domains/register';
}

function getDomainUpdateNameserversPath(): string {
  return '/domains/nameservers';
}

export async function rdashRequest<T = any>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: any,
): Promise<T> {
  const configFromDb = await getRdashConfigFromDb();
  const config: RdashConfig | null = configFromDb
    ? {
        baseUrl: configFromDb.baseUrl,
        resellerId: configFromDb.resellerId,
        apiKey: configFromDb.apiKey,
      }
    : null;

  if (!config) {
    throw new Error('RDASH configuration is not set');
  }

  const fetchFn: any = (globalThis as any).fetch;
  if (!fetchFn) {
    throw new Error('Fetch API is not available in this runtime');
  }

  const url = `${config.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;

  const headers: Record<string, string> = {
    Authorization: getAuthHeader(config),
  };

  let requestBody: string | undefined;

  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }

  const response = await fetchFn(url, {
    method,
    headers,
    body: requestBody,
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      text || `RDASH request failed with status ${response.status} ${response.statusText}`,
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export async function getRdashAccountProfile(): Promise<any | null> {
  try {
    return await rdashRequest('GET', '/account/profile');
  } catch {
    return null;
  }
}

export async function getRdashBalance(): Promise<number | string | null> {
  try {
    const result = await rdashRequest<any>('GET', '/account/balance');

    if (result === null || result === undefined) {
      return null;
    }

    if (typeof result === 'number' || typeof result === 'string') {
      return result;
    }

    if (typeof result === 'object') {
      const direct =
        (result as any).balance ??
        (result as any).credit ??
        (result as any).available_balance ??
        (result as any).availableBalance ??
        null;

      if (direct !== null && direct !== undefined) {
        return direct;
      }

      const nestedKeys = ['data', 'result', 'account'];
      for (const key of nestedKeys) {
        const nested = (result as any)[key];
        if (!nested || typeof nested !== 'object') {
          continue;
        }
        const nestedBalance =
          nested.balance ??
          nested.credit ??
          nested.available_balance ??
          nested.availableBalance ??
          null;
        if (nestedBalance !== null && nestedBalance !== undefined) {
          return nestedBalance;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

export async function registerRdashDomain(payload: any): Promise<any> {
  const body = { ...payload };
  const nameservers = await getRdashNameservers();

  if ((!body.nameservers || !Array.isArray(body.nameservers) || body.nameservers.length === 0) && nameservers.length > 0) {
    body.nameservers = nameservers;
  }

  return rdashRequest('POST', getDomainRegisterPath(), body);
}

export async function updateRdashDomainNameservers(domain: string, payload?: any): Promise<any> {
  const body: any = { ...(payload || {}), domain };
  const nameservers = await getRdashNameservers();

  if ((!body.nameservers || !Array.isArray(body.nameservers) || body.nameservers.length === 0) && nameservers.length > 0) {
    body.nameservers = nameservers;
  }

  return rdashRequest('POST', getDomainUpdateNameserversPath(), body);
}

export async function listRdashDomains(query?: Record<string, any>): Promise<any> {
  let path = '/domains';

  if (query && Object.keys(query).length > 0) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }
      params.append(key, String(value));
    }
    const qs = params.toString();
    if (qs) {
      path = `${path}?${qs}`;
    }
  }

  return rdashRequest('GET', path);
}
