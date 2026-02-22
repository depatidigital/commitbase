import { getCloudflareConfigFromDb } from './integrationConfigService';

interface CloudflareConfig {
  apiToken: string;
  apiBase: string;
  zoneId?: string | null;
  dnsTarget?: string | null;
}

function isIPv4(value: string): boolean {
  const ipv4Regex = /^\d{1,3}(\.\d{1,3}){3}$/;
  return ipv4Regex.test(value);
}

type DnsSummary = {
  a?: string;
  cname?: string;
};

export async function listCloudflareZones(params?: { page?: number; perPage?: number }): Promise<any[] | null> {
  const config = await getCloudflareConfigFromDb();
  if (!config) {
    return null;
  }

  const apiToken = config.apiToken;
  const apiBase = config.apiBase;

  if (!apiToken) {
    return null;
  }

  const fetchFn: any = (globalThis as any).fetch;
  if (!fetchFn) {
    return null;
  }

  const page = params?.page && params.page > 0 ? params.page : 1;
  const perPage = params?.perPage && params.perPage > 0 ? params.perPage : 50;

  const url = `${apiBase}/zones?page=${encodeURIComponent(String(page))}&per_page=${encodeURIComponent(String(perPage))}`;

  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const result = data && Array.isArray(data.result) ? data.result : null;
    if (!result) {
      return null;
    }

    return result;
  } catch {
    return null;
  }
}

export async function getCloudflareNameservers(): Promise<string[] | null> {
  const config = await getCloudflareConfigFromDb();
  if (!config) {
    return null;
  }

  const apiToken = config.apiToken;
  const zoneId = config.zoneId;
  const apiBase = config.apiBase;

  if (!apiToken || !zoneId) {
    return null;
  }

  const fetchFn: any = (globalThis as any).fetch;
  if (!fetchFn) {
    return null;
  }

  const url = `${apiBase}/zones/${zoneId}`;

  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const result = data && data.result;
    const nameServers = result && Array.isArray(result.name_servers) ? result.name_servers : null;

    if (!nameServers || nameServers.length === 0) {
      return null;
    }

    return nameServers.map((ns: string) => ns.trim()).filter((ns: string) => ns.length > 0);
  } catch {
    return null;
  }
}

export async function syncDomainDns(domain: string): Promise<DnsSummary | null> {
  const config = await getCloudflareConfigFromDb();
  if (!config) {
    return null;
  }

  if (!config.dnsTarget || !config.zoneId) {
    return null;
  }

  const fetchFn: any = (globalThis as any).fetch;
  if (!fetchFn) {
    return null;
  }

  const type = isIPv4(config.dnsTarget) ? 'A' : 'CNAME';
  const content = config.dnsTarget;
  const resultSummary: DnsSummary =
    type === 'A' ? { a: content } : { cname: content };

  const searchUrl = `${config.apiBase}/zones/${config.zoneId}/dns_records?type=${encodeURIComponent(
    type,
  )}&name=${encodeURIComponent(domain)}`;

  try {
    const searchResponse = await fetchFn(searchUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!searchResponse.ok) {
      return null;
    }

    const searchData = await searchResponse.json();
    const records = Array.isArray(searchData.result) ? searchData.result : [];
    const existing = records[0];

    if (existing) {
      if (existing.content === content && existing.proxied === true) {
        return resultSummary;
      }

      const updateUrl = `${config.apiBase}/zones/${config.zoneId}/dns_records/${existing.id}`;
      const updateBody = {
        type,
        name: domain,
        content,
        ttl: 1,
        proxied: true,
      };

      const updateResponse = await fetchFn(updateUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updateBody),
      });

      if (!updateResponse.ok) {
        return null;
      }

      return resultSummary;
    }

    const createUrl = `${config.apiBase}/zones/${config.zoneId}/dns_records`;
    const createBody = {
      type,
      name: domain,
      content,
      ttl: 1,
      proxied: true,
    };

    const createResponse = await fetchFn(createUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(createBody),
    });

    if (!createResponse.ok) {
      return null;
    }

    return resultSummary;
  } catch {
    return null;
  }
}

