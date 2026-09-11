import { getCloudflareNameservers } from './cloudflareService';
import { getRdashConfigFromDb, getIntegrationConfigValue } from './integrationConfigService';

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

/**
 * Buy a domain. `POST /domains`, form-encoded, with `nameserver[0..4]` —
 * not `/domains/register`, and not JSON.
 *
 * `customer_id` is required by the API: registrations are billed to a customer
 * and the WHOIS contact is created from it when no contact is named.
 */
export async function registerRdashDomain(payload: {
  domain: string;
  period: number;
  customerId?: number | null;
  nameservers?: string[];
}): Promise<any> {
  const customerId = payload.customerId ?? (await getRdashCustomerId());
  if (!customerId) {
    throw new Error('No RDASH customer to bill the registration to');
  }

  const requested = payload.nameservers?.filter((ns) => ns && ns.trim()) ?? [];
  const nameservers = requested.length > 0 ? requested : await getRdashNameservers();

  const form = new URLSearchParams();
  form.append('name', payload.domain.trim().toLowerCase());
  form.append('period', String(payload.period));
  form.append('customer_id', String(customerId));
  nameservers.slice(0, 5).forEach((ns, i) => form.append(`nameserver[${i}]`, ns.trim()));

  return rdashRequest('POST', '/domains', form);
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

/* ------------------------------------------------------------------ *
 * Domain search: availability + price, for the "register new domain" flow
 *
 * Shapes below follow the RDASH OpenAPI spec at https://api.rdash.id/swagger/v1
 * ------------------------------------------------------------------ */

/**
 * Shown by default. The account sells ~50 extensions and every row costs one
 * availability lookup, so a search offers these and hides the rest behind an
 * explicit "show all" — the full list is still sold, just not checked upfront.
 *
 * Also the fallback list when the price list cannot be read at all.
 */
export const SEARCH_TLDS = ['com', 'id', 'co.id', 'my.id', 'net', 'org', 'web.id', 'biz.id'];

/**
 * `GET /account/prices` prices a whole period at a time — `registration["3"]`
 * is the total for three years, not a yearly rate to multiply. Keeping the map
 * means we quote what the registrar will actually charge, including the
 * per-extension discounts that break a naive price x years.
 */
export type TldPrice = {
  extension: string;
  currency: string;
  /** period in years -> total price for that period */
  registration: Record<number, number>;
  renewal: Record<number, number>;
};

/** Parse a price that may arrive as a number or as formatted text ("Rp 150.000"). */
export const parsePrice = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    // "Rp 150.000" / "150000.00" / "150,000"
    const digits = value.replace(/[^0-9.,]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(/,/g, '');
    const parsed = Number.parseFloat(digits);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** `{"1": 100000, "2": "200000.00"}` -> `{1: 100000, 2: 200000}` */
const periodMap = (value: unknown): Record<number, number> => {
  const periods: Record<number, number> = {};
  if (!value || typeof value !== 'object') return periods;

  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const years = Number.parseInt(key, 10);
    const price = parsePrice(raw);
    if (Number.isFinite(years) && years > 0 && price !== null) periods[years] = price;
  }
  return periods;
};

let priceCache: { at: number; prices: Record<string, TldPrice> } | null = null;
const PRICE_TTL_MS = 60 * 60 * 1000;

/**
 * The reseller account's price list, keyed by extension without the leading
 * dot. This doubles as the list of TLDs we can actually sell — an extension
 * with no price is one the account cannot register.
 */
export async function getRdashPricing(): Promise<Record<string, TldPrice>> {
  if (priceCache && Date.now() - priceCache.at < PRICE_TTL_MS) return priceCache.prices;

  const prices: Record<string, TldPrice> = {};

  try {
    let lastPage = 1;

    for (let page = 1; page <= lastPage && page <= 20; page++) {
      const payload: any = await rdashRequest('GET', `/account/prices?page=${page}&limit=100`);
      lastPage = Number(payload?.meta?.last_page) || 1;

      for (const row of Array.isArray(payload?.data) ? payload.data : []) {
        const extension = String(row?.domain_extension?.extension ?? '').trim().replace(/^\./, '').toLowerCase();
        if (!extension) continue;

        prices[extension] = {
          extension,
          currency: String(row?.currency ?? 'IDR').toUpperCase(),
          registration: periodMap(row?.registration),
          renewal: periodMap(row?.renewal),
        };
      }
    }
  } catch (error) {
    // no price list = "price on request", not a broken search
    console.error('RDASH pricing unavailable:', (error as Error).message);
  }

  // an empty list is a failed read — caching it would hide prices for an hour
  // after RDASH recovers
  if (Object.keys(prices).length > 0) priceCache = { at: Date.now(), prices };
  return prices;
}

/**
 * `GET /domains/availability` — the registrar's own check.
 *
 * `available` is an integer flag, not a boolean: `{ name, available: 0 | 1,
 * message }`. The spec declares `data` as an array but the live API returns a
 * bare object, so both are accepted.
 *
 * Repeated checks of the same name are rate limited upstream and come back as
 * an error, which reads as "no answer" — RDAP is asked first for that reason.
 */
export async function checkRdashAvailability(domain: string): Promise<boolean | null> {
  try {
    const payload: any = await rdashRequest(
      'GET',
      `/domains/availability?domain=${encodeURIComponent(domain)}`,
    );

    const wanted = domain.trim().toLowerCase();
    const rows: any[] = Array.isArray(payload?.data)
      ? payload.data
      : payload?.data
        ? [payload.data]
        : [];
    const row =
      rows.find((r) => String(r?.name ?? '').trim().toLowerCase() === wanted) ?? rows[0];

    const flag = row?.available;
    if (typeof flag === 'number') return flag === 1;
    if (typeof flag === 'boolean') return flag;
    if (typeof flag === 'string' && flag.trim()) {
      const normalized = flag.trim().toLowerCase();
      if (['1', 'true', 'available', 'yes'].includes(normalized)) return true;
      if (['0', 'false', 'taken', 'registered', 'unavailable', 'no'].includes(normalized)) return false;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Registrations are billed to a customer, and `customer_id` is required.
 * The account's first customer is the intended default; set a `customerId`
 * integration config value to bill somewhere else.
 */
export async function getRdashCustomerId(): Promise<number | null> {
  const configured = await getIntegrationConfigValue('rdash', 'customerId');
  if (configured && Number.isFinite(Number(configured))) return Number(configured);

  try {
    const payload: any = await rdashRequest('GET', '/customers?limit=1');
    const id = Number(payload?.data?.[0]?.id);
    if (Number.isFinite(id)) return id;
  } catch (error) {
    console.error('Could not resolve an RDASH customer:', (error as Error).message);
  }

  return null;
}
