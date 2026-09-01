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

export interface CloudflareZoneInfo {
  id: string;
  name: string;
  nameServers: string[];
}

async function getCloudflareFetchConfig(): Promise<{ fetchFn: any; config: CloudflareConfig } | null> {
  const config = await getCloudflareConfigFromDb();
  if (!config || !config.apiToken) {
    return null;
  }

  const fetchFn: any = (globalThis as any).fetch;
  if (!fetchFn) {
    return null;
  }

  return { fetchFn, config };
}

export async function listCloudflareZones(params?: { page?: number; perPage?: number }): Promise<any[] | null> {
  const shared = await getCloudflareFetchConfig();
  if (!shared) {
    return null;
  }

  const { fetchFn, config } = shared;
  const apiBase = config.apiBase;

  const page = params?.page && params.page > 0 ? params.page : 1;
  const perPage = params?.perPage && params.perPage > 0 ? params.perPage : 50;

  const url = `${apiBase}/zones?page=${encodeURIComponent(String(page))}&per_page=${encodeURIComponent(String(perPage))}`;

  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
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

export async function getOrCreateCloudflareZone(domain: string): Promise<CloudflareZoneInfo | null> {
  const shared = await getCloudflareFetchConfig();
  if (!shared) {
    return null;
  }

  const { fetchFn, config } = shared;
  const apiBase = config.apiBase;

  const trimmedDomain = domain.trim().toLowerCase();

  const searchUrl = `${apiBase}/zones?name=${encodeURIComponent(trimmedDomain)}`;

  try {
    const searchResponse = await fetchFn(searchUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (searchResponse.ok) {
      const searchData = await searchResponse.json();
      const zones = Array.isArray(searchData.result) ? searchData.result : [];
      const existing = zones[0];

      if (existing && existing.id) {
        const nameServers =
          Array.isArray(existing.name_servers) && existing.name_servers.length > 0
            ? existing.name_servers
            : [];

        return {
          id: String(existing.id),
          name: String(existing.name || trimmedDomain),
          nameServers,
        };
      }
    }
  } catch {
  }

  const createUrl = `${apiBase}/zones`;
  const createBody = {
    name: trimmedDomain,
    jump_start: false,
  };

  try {
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

    const createData = await createResponse.json();
    const result = createData && createData.result;
    if (!result || !result.id) {
      return null;
    }

    const nameServers =
      Array.isArray(result.name_servers) && result.name_servers.length > 0
        ? result.name_servers
        : [];

    return {
      id: String(result.id),
      name: String(result.name || trimmedDomain),
      nameServers,
    };
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

export async function listCloudflareDnsRecords(zoneId: string): Promise<any[] | null> {
  const shared = await getCloudflareFetchConfig();
  if (!shared) {
    return null;
  }

  const { fetchFn, config } = shared;
  const apiBase = config.apiBase;
  const trimmedZoneId = zoneId.trim();

  if (!trimmedZoneId) {
    return null;
  }

  const url = `${apiBase}/zones/${encodeURIComponent(trimmedZoneId)}/dns_records?per_page=100`;

  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const records = data && Array.isArray(data.result) ? data.result : null;
    if (!records) {
      return null;
    }

    return records;
  } catch {
    return null;
  }
}

export async function syncDomainDns(domain: string, zoneIdOverride?: string): Promise<DnsSummary | null> {
  const shared = await getCloudflareFetchConfig();
  if (!shared) {
    return null;
  }

  const { fetchFn, config } = shared;

  const zoneIdToUse = zoneIdOverride || config.zoneId;

  if (!config.dnsTarget || !zoneIdToUse) {
    return null;
  }

  const type = isIPv4(config.dnsTarget) ? 'A' : 'CNAME';
  const content = config.dnsTarget;
  const resultSummary: DnsSummary =
    type === 'A' ? { a: content } : { cname: content };

  const searchUrl = `${config.apiBase}/zones/${zoneIdToUse}/dns_records?type=${encodeURIComponent(
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

      const updateUrl = `${config.apiBase}/zones/${zoneIdToUse}/dns_records/${existing.id}`;
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

    const createUrl = `${config.apiBase}/zones/${zoneIdToUse}/dns_records`;
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

export type ZoneSslState = {
  status: 'ACTIVE' | 'PENDING' | 'EXPIRED' | 'ERROR';
  expiry: Date | null;
};

/**
 * Real SSL state for a zone, straight from Cloudflare's certificate packs.
 * Cloudflare terminates TLS for these domains, so it is the only honest source —
 * we never issue certificates ourselves.
 */
export async function getZoneSslState(zoneId: string): Promise<ZoneSslState | null> {
  const shared = await getCloudflareFetchConfig();
  if (!shared) {
    return null;
  }

  const { fetchFn, config } = shared;
  const trimmedZoneId = zoneId.trim();
  if (!trimmedZoneId) {
    return null;
  }

  const url = `${config.apiBase}/zones/${encodeURIComponent(trimmedZoneId)}/ssl/certificate_packs?status=all`;

  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const packs: any[] = data && Array.isArray(data.result) ? data.result : [];

    if (packs.length === 0) {
      return { status: 'PENDING', expiry: null };
    }

    // an active pack wins; otherwise report on the first one Cloudflare lists
    const pack = packs.find((p) => p?.status === 'active') || packs[0];

    const expiries: number[] = (Array.isArray(pack?.certificates) ? pack.certificates : [])
      .map((c: any) => Date.parse(c?.expires_on))
      .filter((t: number) => Number.isFinite(t));

    const expiry = expiries.length > 0 ? new Date(Math.max(...expiries)) : null;

    let status: ZoneSslState['status'];
    switch (pack?.status) {
      case 'active':
        status = 'ACTIVE';
        break;
      case 'initializing':
      case 'pending_validation':
      case 'pending_issuance':
      case 'pending_deployment':
      case 'pending_cleanup':
        status = 'PENDING';
        break;
      case 'expired':
      case 'deleted':
        status = 'EXPIRED';
        break;
      default:
        status = 'ERROR';
    }

    // an active pack whose certificate already lapsed is not active
    if (status === 'ACTIVE' && expiry && expiry.getTime() < Date.now()) {
      status = 'EXPIRED';
    }

    return { status, expiry };
  } catch {
    return null;
  }
}

export type ImportableRecord = {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
};

/**
 * Copy records into a zone, skipping any Cloudflare already has with the same
 * type+name+content. Returns what happened per record so the caller can report it.
 */
export async function importDnsRecords(
  zoneId: string,
  records: ImportableRecord[],
): Promise<{ imported: number; skipped: number; failed: string[] }> {
  const shared = await getCloudflareFetchConfig();
  if (!shared) {
    return { imported: 0, skipped: 0, failed: records.map((r) => `${r.type} ${r.name}`) };
  }

  const { fetchFn, config } = shared;
  const existing = (await listCloudflareDnsRecords(zoneId)) || [];

  let imported = 0;
  let skipped = 0;
  const failed: string[] = [];

  for (const record of records) {
    const label = `${record.type} ${record.name}`;

    const duplicate = existing.some(
      (e: any) =>
        String(e.type).toUpperCase() === record.type.toUpperCase() &&
        String(e.name).toLowerCase() === record.name.toLowerCase() &&
        String(e.content) === record.content,
    );

    if (duplicate) {
      skipped++;
      continue;
    }

    try {
      const response = await fetchFn(`${config.apiBase}/zones/${zoneId}/dns_records`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: record.type.toUpperCase(),
          name: record.name,
          content: record.content,
          ttl: record.ttl && record.ttl > 0 ? record.ttl : 1,
          ...(record.priority !== undefined && { priority: record.priority }),
        }),
      });

      if (response.ok) {
        imported++;
      } else {
        failed.push(label);
      }
    } catch {
      failed.push(label);
    }
  }

  return { imported, skipped, failed };
}
