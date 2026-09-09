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

/**
 * `registered` — the registry returned a record.
 * `unregistered` — the registry answered 404: the name is free.
 * `unknown` — nobody authoritative answered (no RDAP for the TLD, timeout, 5xx).
 *
 * The three are worth separating because a 404 is a real answer, and treating
 * it as silence makes every free domain look unregistrable.
 */
type RdapLookup =
  | { outcome: 'registered'; data: RdapResponse }
  | { outcome: 'unregistered'; data: null }
  | { outcome: 'unknown'; data: null };

async function lookupRdap(name: string, attempt = 0): Promise<RdapLookup> {
  const domain = String(name || '').trim().toLowerCase();
  // RDAP answers for registrable names only — a host label like www.x.com 404s
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return { outcome: 'unknown', data: null };

  // Registries throttle bursts, and a throttled lookup is indistinguishable
  // from "no RDAP service" to the caller — which shows a free domain as
  // unregistrable. One retry turns most of those back into a real answer.
  const retry = async (): Promise<RdapLookup> => {
    if (attempt >= 1) return { outcome: 'unknown', data: null };
    await new Promise((resolve) => setTimeout(resolve, 750));
    return lookupRdap(domain, attempt + 1);
  };

  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      // rdap.org sits behind Cloudflare and 403s a request with no User-Agent
      headers: { accept: 'application/rdap+json', 'user-agent': 'commitbase-domain-sync/1.0' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.ok) return { outcome: 'registered', data: (await res.json()) as RdapResponse };

    // rdap.org is a bootstrap: it redirects to the registry that owns the TLD.
    // A 404 from the *registry* means the name is not registered. A 404 still
    // at rdap.org means the TLD has no RDAP service at all — that is silence.
    if (res.status === 404) {
      const answeredByRegistry = !new URL(res.url).hostname.endsWith('rdap.org');
      return answeredByRegistry
        ? { outcome: 'unregistered', data: null }
        : { outcome: 'unknown', data: null };
    }

    // 429 / 5xx are "ask again", not "no such service"
    return retry();
  } catch {
    // timeouts, DNS, malformed JSON — RDAP is best-effort, never fail the caller
    return retry();
  }
}

async function fetchRdap(name: string): Promise<RdapResponse | null> {
  return (await lookupRdap(name)).data;
}

/**
 * Who a domain is registered with, straight from the registry.
 * Returns null when the TLD has no RDAP service or the name is not registered.
 */
export async function getDomainRegistration(name: string): Promise<DomainRegistration | null> {
  const data = await fetchRdap(name);
  return data ? toRegistration(name, data) : null;
}

function toRegistration(name: string, data: RdapResponse): DomainRegistration {
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

/**
 * Availability and, when taken, who holds it — from one registry round-trip.
 * `available`: true = free, false = taken, null = no authoritative answer.
 */
export async function getDomainAvailability(
  name: string,
): Promise<{ available: boolean | null; registration: DomainRegistration | null }> {
  const lookup = await lookupRdap(name);

  if (lookup.outcome === 'unregistered') return { available: true, registration: null };
  if (lookup.outcome === 'unknown') return { available: null, registration: null };

  return { available: false, registration: toRegistration(name, lookup.data) };
}
