/**
 * Domain registration expiry via RDAP — the structured, ICANN-mandated
 * replacement for WHOIS. rdap.org bootstraps to the authoritative registry,
 * so we do not have to keep a TLD -> server table.
 *
 * Not every registry publishes an expiration event (many ccTLDs do not), so
 * null is a normal answer, not an error.
 */

type RdapResponse = {
  events?: { eventAction?: string; eventDate?: string }[];
};

const TIMEOUT_MS = 8000;

export async function getDomainExpiry(name: string): Promise<Date | null> {
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

    const data = (await res.json()) as RdapResponse;
    const event = data.events?.find((e) => e.eventAction === 'expiration');
    if (!event?.eventDate) return null;

    const date = new Date(event.eventDate);
    return Number.isFinite(date.getTime()) ? date : null;
  } catch {
    // timeouts, DNS, malformed JSON — expiry is best-effort, never fail the sync
    return null;
  }
}
