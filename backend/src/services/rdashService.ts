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
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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
    if (body instanceof URLSearchParams) {
      // the write endpoints are documented as application/x-www-form-urlencoded
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      requestBody = body.toString();
    } else {
      headers['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(body);
    }
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

/**
 * Point a domain's nameservers somewhere else.
 * Documented as `PUT /domains/{id}/ns`, form-encoded, with `nameserver[0..4]` —
 * not JSON, and not the `/domains/nameservers` path this used to call.
 */
export async function updateRdashDomainNameservers(
  domain: string,
  payload?: { nameservers?: string[] },
): Promise<any> {
  const requested = payload?.nameservers?.filter((ns) => ns && ns.trim().length > 0) ?? [];
  const nameservers = requested.length > 0 ? requested : await getRdashNameservers();

  if (nameservers.length < 2) {
    throw new Error('At least two nameservers are required');
  }

  const rdashDomain = await findRdashDomain(domain);
  if (!rdashDomain) {
    throw new Error(`${domain} was not found in the RDASH account`);
  }

  const current = rdashDomain.nameservers.map((ns) => ns.toLowerCase()).sort().join(',');
  const next = nameservers.map((ns) => ns.trim().toLowerCase()).sort().join(',');

  // RDASH rejects a no-op write with a validation error, so treat it as already done
  if (current === next) {
    return { success: true, message: 'Nameservers already set', unchanged: true };
  }

  const form = new URLSearchParams();
  nameservers.slice(0, 5).forEach((ns, i) => form.append(`nameserver[${i}]`, ns.trim()));

  return rdashRequest('PUT', `/domains/${rdashDomain.id}/ns`, form);
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

export interface RdashDomainRef {
  id: number | string;
  name: string;
  nameservers: string[];
}

/** Find one domain in the reseller account by name, following RDASH's 10-per-page listing. */
export async function findRdashDomain(name: string): Promise<RdashDomainRef | null> {
  const wanted = name.trim().toLowerCase();
  let lastPage = 1;

  for (let page = 1; page <= lastPage && page <= 100; page++) {
    const raw: any = await listRdashDomains({ page });
    const rows: any[] = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
    lastPage = Number(raw?.meta?.last_page) || 1;

    const match = rows.find(
      (row) => String(row?.name || row?.domain || '').trim().toLowerCase() === wanted,
    );

    if (match) {
      return {
        id: match.id,
        name: wanted,
        nameservers: [
          match.nameserver_1,
          match.nameserver_2,
          match.nameserver_3,
          match.nameserver_4,
          match.nameserver_5,
        ]
          .map((ns: any) => String(ns || '').trim())
          .filter((ns: string) => ns.length > 0),
      };
    }
  }

  return null;
}

/** DNS records RDASH holds for a domain, while it is still authoritative for it. */
export async function getRdashDomainDns(domainId: number | string): Promise<any[]> {
  const raw: any = await rdashRequest('GET', `/domains/${domainId}/dns`);
  return Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
}

/**
 * Renew a domain registration at RDASH.
 * Documented as `POST /domains/{id}/renew`, form-encoded, with `year`.
 * This spends reseller balance — callers must confirm with the user first.
 */
export async function renewRdashDomain(domain: string, years = 1): Promise<any> {
  const rdashDomain = await findRdashDomain(domain);
  if (!rdashDomain) {
    throw new Error(`${domain} was not found at the registrar`);
  }

  const form = new URLSearchParams();
  form.append('year', String(years));

  return rdashRequest('POST', `/domains/${rdashDomain.id}/renew`, form);
}
