/**
 * Domain registration expiry via RDAP — the structured, ICANN-mandated
 * replacement for WHOIS. rdap.org bootstraps to the authoritative registry,
 * so we do not have to keep a TLD -> server table.
 *
 * Not every registry publishes an expiration event (many ccTLDs do not), so
 * null is a normal answer, not an error.
 */

const TIMEOUT_MS = 8000;

type RdapResponse = {
  ldhName?: string;
  status?: string[];
  events?: { eventAction?: string; eventDate?: string }[];
  nameservers?: { ldhName?: string }[];
  entities?: RdapEntity[];
};

type RdapEntity = {
  roles?: string[];
  handle?: string;
  // jCard: ['vcard', [['fn', {}, 'text', 'Registrar Name'], ...]]
  vcardArray?: [string, any[][]];
  entities?: RdapEntity[];
};

export type DomainRegistration = {
  domain: string;
  registrar: string | null;
  /** IANA registrar id, when the registry publishes one */
  registrarId: string | null;
  status: string[];
  registeredAt: string | null;
  updatedAt: string | null;
  expiresAt: string | null;
  nameservers: string[];
};

function vcardValue(entity: RdapEntity, field: string): string | null {
  const entries = entity.vcardArray?.[1];
  if (!Array.isArray(entries)) return null;
  const row = entries.find((e) => Array.isArray(e) && e[0] === field);
  const value = row?.[3];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function findRegistrar(data: RdapResponse): RdapEntity | null {
  for (const entity of data.entities ?? []) {
    if (entity.roles?.includes('registrar')) return entity;
  }
  return null;
}

function eventDate(data: RdapResponse, action: string): string | null {
  const date = data.events?.find((e) => e.eventAction === action)?.eventDate;
  if (!date) return null;
  const parsed = new Date(date);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

async function fetchRdap(name: string): Promise<RdapResponse | null> {
  const domain = String(name || '').trim().toLowerCase();
  // RDAP answers for registrable names only — a host label like www.x.com 404s
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;

  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      // rdap.org sits behind Cloudflare and 403s a request with no User-Agent
      headers: { accept: 'application/rdap+json', 'user-agent': 'commitbase-domain-sync/1.0' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 404 = not registered, or a TLD outside RDAP. Both mean "no answer".
    if (!res.ok) return null;

    return (await res.json()) as RdapResponse;
  } catch {
    // timeouts, DNS, malformed JSON — RDAP is best-effort, never fail the caller
    return null;
  }
}

/**
 * Who a domain is registered with, straight from the registry.
 * Returns null when the TLD has no RDAP service or the name is not registered.
 */
export async function getDomainRegistration(name: string): Promise<DomainRegistration | null> {
  const data = await fetchRdap(name);
  if (!data) return null;

  const registrar = findRegistrar(data);

  return {
    domain: data.ldhName?.toLowerCase() || String(name).trim().toLowerCase(),
    registrar: registrar ? vcardValue(registrar, 'fn') : null,
    registrarId:
      (registrar?.entities?.[0]?.handle && String(registrar.entities[0].handle)) ||
      (registrar?.handle ? String(registrar.handle) : null),
    status: Array.isArray(data.status) ? data.status : [],
    registeredAt: eventDate(data, 'registration'),
    updatedAt: eventDate(data, 'last changed'),
    expiresAt: eventDate(data, 'expiration'),
    nameservers: (data.nameservers ?? [])
      .map((ns) => String(ns?.ldhName || '').trim().toLowerCase())
      .filter((ns) => ns.length > 0),
  };
}

export async function getDomainExpiry(name: string): Promise<Date | null> {
  const data = await fetchRdap(name);
  const expiry = data ? eventDate(data, 'expiration') : null;
  return expiry ? new Date(expiry) : null;
}
