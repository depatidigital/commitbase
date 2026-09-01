import { prisma } from '../lib/prisma';
import { listCloudflareZones, getZoneSslState } from './cloudflareService';
import { listRdashDomains } from './rdashService';
import { getDomainExpiry } from './rdapService';

export type DomainSyncResult = {
  total: number;
  created: number;
  updated: number;
  cfOnly: number;
  rdashOnly: number;
  errors?: Record<string, string>;
};

/**
 * Pull the domain inventory from Cloudflare + RDASH and reconcile it into the
 * database. `ownerUserId` only owns rows we create — every synced domain lands
 * unassigned until an admin puts it in an organization.
 *
 * Called from POST /api/domains/sync and from the scheduled job in cron.ts.
 */
/**
 * Domain status means "is this registration live", so the registrar wins when we have it.
 * Cloudflare zone health is a separate signal (cfZoneId / the "No zone" badge) — a
 * perfectly valid domain with no zone yet is ACTIVE, not PENDING.
 */
function domainStatus(rdash: any, zone: any): 'ACTIVE' | 'INACTIVE' | 'PENDING' | 'ERROR' {
  if (rdash) {
    const label = String(rdash.status_label || '').trim().toLowerCase();

    if (label === 'active') return 'ACTIVE';
    if (label.startsWith('pending')) return 'PENDING';
    if (['expired', 'suspended', 'deleted', 'inactive', 'transferred'].includes(label)) {
      return 'INACTIVE';
    }
    // RDASH also sends a numeric status, where 1 is active
    if (Number(rdash.status) === 1) return 'ACTIVE';
    return 'PENDING';
  }

  return zone?.status === 'active' ? 'ACTIVE' : 'PENDING';
}

export type SyncState = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  result: DomainSyncResult | null;
  error: string | null;
};

/**
 * ponytail: one in-memory job, since the scheduler already assumes a single
 * backend instance. Move to a table or a queue if that ever stops being true.
 */
let syncState: SyncState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
};

export function getDomainSyncState(): SyncState {
  return syncState;
}

/**
 * Kick off a sync and return immediately — a full run takes minutes, which is
 * longer than any sane HTTP timeout. Callers poll getDomainSyncState().
 * A second call while one is running is a no-op.
 */
export function startDomainSync(ownerUserId: string): SyncState {
  if (syncState.running) return syncState;

  syncState = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    error: null,
  };

  void syncDomains(ownerUserId)
    .then((result) => {
      syncState = {
        ...syncState,
        running: false,
        finishedAt: new Date().toISOString(),
        result,
      };
    })
    .catch((error: unknown) => {
      console.error('Domain sync failed:', error);
      syncState = {
        ...syncState,
        running: false,
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Sync failed',
      };
    });

  return syncState;
}

export async function syncDomains(ownerUserId: string): Promise<DomainSyncResult> {
  const [cfResult, rdashResult] = await Promise.allSettled([
    (async () => {
      const perPage = 50;
      const zones: any[] = [];
      // ponytail: sequential paging, fine for a few hundred zones
      for (let page = 1; page <= 50; page++) {
        const batch = await listCloudflareZones({ page, perPage });
        if (batch === null) throw new Error('Cloudflare zones unavailable');
        zones.push(...batch);
        if (batch.length < perPage) break;
      }
      return zones;
    })(),
    (async () => {
      // RDASH pages at 10 per response and rejects per_page — follow meta.last_page
      const rows: any[] = [];
      let lastPage = 1;
      for (let page = 1; page <= lastPage && page <= 100; page++) {
        const raw: any = await listRdashDomains({ page });
        const batch = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
        rows.push(...batch);
        lastPage = Number(raw?.meta?.last_page) || 1;
      }
      return rows;
    })(),
  ]);

  const errors: Record<string, string> = {};

  const zones: any[] = cfResult.status === 'fulfilled' ? cfResult.value : [];
  if (cfResult.status === 'rejected') {
    errors.cloudflare = 'Failed to fetch Cloudflare zones. Check the Cloudflare integration config.';
  }

  let rdashRows: any[] = [];
  if (rdashResult.status === 'fulfilled') {
    rdashRows = rdashResult.value;
  } else {
    errors.rdash = 'Failed to fetch RDASH domains. Check the RDASH integration config.';
  }

  // one row per domain name, merged from both sources
  type Merged = { name: string; zone?: any; rdash?: any };
  const merged = new Map<string, Merged>();
  const put = (rawName: any, patch: Partial<Merged>) => {
    const name = String(rawName || '').trim().toLowerCase();
    if (!name) return;
    merged.set(name, { ...(merged.get(name) || { name }), ...patch, name });
  };

  for (const zone of zones) put(zone?.name, { zone });
  for (const row of rdashRows) put(row?.domain || row?.name, { rdash: row });

  let created = 0;
  let updated = 0;
  const now = new Date();

  for (const entry of merged.values()) {
    const { name, zone, rdash } = entry;

    const cfZoneId = zone?.id ? String(zone.id) : null;
    const cloudflare = zone
      ? {
          zoneId: cfZoneId,
          zoneName: name,
          nameservers: Array.isArray(zone.name_servers) ? zone.name_servers : [],
          synced: true,
        }
      : null;

    // real certificate state — Cloudflare terminates TLS, so it is the only honest source
    const ssl = cfZoneId ? await getZoneSslState(cfZoneId) : null;

    const existing = await prisma.domain.findUnique({ where: { name } });

    // RDASH is not consistent about the field name, so try the ones it actually sends
    const rawExpiry =
      rdash?.expired_at ?? rdash?.expiryDate ?? rdash?.expire_date ?? rdash?.expiresAt ?? null;
    const parsedExpiry = rawExpiry ? new Date(rawExpiry) : null;
    let expiresAt =
      parsedExpiry && Number.isFinite(parsedExpiry.getTime()) ? parsedExpiry : null;

    // domains we do not buy through RDASH have no expiry — ask the registry directly.
    // Only when we still have nothing stored, so a sync is not one RDAP call per domain.
    if (!expiresAt && !existing?.expiresAt) {
      expiresAt = await getDomainExpiry(name);
    }

    if (existing) {
      await prisma.domain.update({
        where: { id: existing.id },
        data: {
          ...(cfZoneId && { cfZoneId }),
          status: domainStatus(rdash, zone),
          ...(ssl && { sslStatus: ssl.status, sslExpiry: ssl.expiry }),
          ...(expiresAt && { expiresAt }),
          ...(cloudflare && {
            customConfig: { ...((existing.customConfig as any) || {}), cloudflare },
          }),
          // never overwrite a registrar someone set by hand
          ...(rdash && { registrar: 'RDASH' }),
          ...(!rdash && !existing.registrar && zone && { registrar: 'EXTERNAL' }),
          lastSyncedAt: now,
        },
      });
      updated++;
    } else {
      await prisma.domain.create({
        data: {
          name,
          status: domainStatus(rdash, zone),
          cfZoneId,
          registrar: rdash ? 'RDASH' : zone ? 'EXTERNAL' : null,
          ...(ssl && { sslStatus: ssl.status, sslExpiry: ssl.expiry }),
          expiresAt,
          ...(cloudflare && { customConfig: { cloudflare } }),
          organizationId: null,
          userId: ownerUserId,
          lastSyncedAt: now,
        },
      });
      created++;
    }
  }

  const cfNames = new Set(zones.map((z: any) => String(z?.name || '').trim().toLowerCase()));
  const rdashNames = new Set(
    rdashRows.map((r: any) => String(r?.domain || r?.name || '').trim().toLowerCase()),
  );

  return {
    total: merged.size,
    created,
    updated,
    cfOnly: [...cfNames].filter((n) => n && !rdashNames.has(n)).length,
    rdashOnly: [...rdashNames].filter((n) => n && !cfNames.has(n)).length,
    ...(Object.keys(errors).length && { errors }),
  };
}
