import { prisma } from '../lib/prisma';
import { getOrCreateCloudflareZone, syncDomainDns } from './cloudflareService';
import { registerRdashDomain, updateRdashDomainNameservers } from './rdashService';
import { getDomainExpiry } from './rdapService';
import { refreshDomainSummary } from './domainSyncService';
import { ensureWildcardRecord } from './appDnsService';

/**
 * Buying a domain takes tens of seconds — the registrar order, the Cloudflare
 * zone, then the nameserver switch. The HTTP request only queues the work; this
 * service does it in the background and the domains list polls the row.
 *
 * State lives in `customConfig.provisioning` — no migration for a field that
 * only matters for the few minutes after a purchase.
 *
 * States: QUEUED → REGISTERING → WIRING → DONE, or FAILED.
 * Only QUEUED and WIRING are ever retried: REGISTERING is the step that spends
 * money, so a run that dies inside it stays stuck for a human to look at.
 */
export type ProvisionState = 'QUEUED' | 'REGISTERING' | 'WIRING' | 'DONE' | 'FAILED';

export type Provisioning = {
  state: ProvisionState;
  /** what is happening right now, shown as-is in the UI */
  step: string;
  error?: string | null;
  years: number;
  queuedAt: string;
  updatedAt: string;
};

const isProvisioning = (config: any): Provisioning | null =>
  config && typeof config === 'object' && config.provisioning ? (config.provisioning as Provisioning) : null;

async function setProvisioning(
  domainId: string,
  patch: Partial<Provisioning>,
  extra: { status?: 'ACTIVE' | 'PENDING' | 'ERROR'; config?: Record<string, unknown> } = {},
) {
  const domain = await prisma.domain.findUnique({ where: { id: domainId }, select: { customConfig: true } });
  const config = (domain?.customConfig as any) ?? {};

  await prisma.domain.update({
    where: { id: domainId },
    data: {
      ...(extra.status && { status: extra.status }),
      customConfig: {
        ...config,
        ...extra.config,
        provisioning: { ...(config.provisioning ?? {}), ...patch, updatedAt: new Date().toISOString() },
      },
    },
  });
}

/** Jobs running in this process, so a cron sweep never doubles up on one. */
const running = new Set<string>();

/**
 * Run the purchase and wiring for one queued domain. Safe to call twice: the
 * state check is the guard, and everything after the order is idempotent.
 */
export async function provisionDomain(domainId: string): Promise<void> {
  if (running.has(domainId)) return;
  running.add(domainId);

  try {
    const domain = await prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain) return;

    const provisioning = isProvisioning(domain.customConfig);
    if (!provisioning || (provisioning.state !== 'QUEUED' && provisioning.state !== 'WIRING')) return;

    const years = provisioning.years || 1;

    // The purchase. Skipped when we are resuming a run that already paid.
    if (provisioning.state === 'QUEUED') {
      await setProvisioning(domainId, { state: 'REGISTERING', step: 'Ordering the domain from the registrar' });

      try {
        const receipt = await registerRdashDomain({ domain: domain.name, period: years });
        await setProvisioning(
          domainId,
          { state: 'WIRING', step: 'Setting up DNS' },
          { config: { rdash: receipt ?? null, registeredAt: new Date().toISOString() } },
        );
      } catch (error: any) {
        console.error(`❌ provision ${domain.name}: registrar refused —`, error?.message);
        await setProvisioning(
          domainId,
          {
            state: 'FAILED',
            step: 'Registration failed',
            error: `Registrar refused the registration: ${String(error?.message ?? '').slice(0, 300)}`,
          },
          { status: 'ERROR' },
        );
        return;
      }
    }

    // Bought and paid for from here on — a failure leaves the row in WIRING so
    // the next sweep picks it up again instead of losing the domain.
    try {
      const zone = await getOrCreateCloudflareZone(domain.name);
      const dnsRecords: any = await syncDomainDns(domain.name, zone?.id);

      if (zone) {
        await setProvisioning(domainId, { step: 'Pointing the domain at our nameservers' });
        try {
          await updateRdashDomainNameservers(domain.name, { nameservers: zone.nameServers });
        } catch (error: any) {
          // non-fatal: the domain is ours, an admin can set these by hand
          console.error(`Could not set nameservers for ${domain.name}:`, error?.message);
        }
      }

      await prisma.domain.update({
        where: { id: domainId },
        data: {
          status: zone ? 'ACTIVE' : 'PENDING',
          dnsRecords,
          cfZoneId: zone?.id ?? null,
          expiresAt: (await getDomainExpiry(domain.name)) ?? null,
          lastSyncedAt: new Date(),
        },
      });

      await setProvisioning(
        domainId,
        { state: 'DONE', step: 'Ready', error: null },
        {
          config: {
            ...(zone && {
              cloudflare: {
                zoneId: zone.id,
                zoneName: zone.name,
                nameservers: zone.nameServers,
                synced: true,
              },
            }),
          },
        },
      );
      // A domain we bought is entirely ours: one wildcard means every app
      // deployed under it resolves without a DNS call of its own.
      if (zone) await ensureWildcardRecord(domainId).catch(() => {});
      await refreshDomainSummary(domainId);
      console.log(`✅ provision ${domain.name}: ready`);
    } catch (error: any) {
      console.error(`⚠️  provision ${domain.name}: wiring failed —`, error?.message);
      await setProvisioning(domainId, {
        step: 'DNS setup failed — retrying',
        error: String(error?.message ?? '').slice(0, 300),
      });
    }
  } finally {
    running.delete(domainId);
  }
}

/**
 * Sweep for work the in-process kick missed — a backend restart mid-order, or
 * wiring that failed and has to be tried again.
 */
export async function provisionPending(): Promise<string> {
  const domains = await prisma.domain.findMany({
    where: { status: { in: ['PENDING', 'ERROR'] }, registrar: 'RDASH' },
    select: { id: true, customConfig: true },
  });

  const pending = domains.filter((d) => {
    const state = isProvisioning(d.customConfig)?.state;
    return state === 'QUEUED' || state === 'WIRING';
  });

  for (const domain of pending) await provisionDomain(domain.id);
  return pending.length === 0 ? 'nothing pending' : `${pending.length} domain(s) provisioned`;
}
