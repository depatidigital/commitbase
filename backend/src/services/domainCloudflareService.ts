import type { Domain } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { findCloudflareZone, getOrCreateCloudflareZone, getZoneSslState, importDnsRecords } from './cloudflareService';
import { findRdashDomain, getRdashDomainDns, updateRdashDomainNameservers } from './rdashService';

/** RDASH sends records in a few shapes — normalise to what Cloudflare's API wants. */
export const toImportableRecords = (rows: any[], domainName: string) =>
  rows
    .map((row) => {
      const type = String(row?.type || row?.record_type || '').trim().toUpperCase();
      const rawName = String(row?.name || row?.host || row?.hostname || '').trim();
      const content = String(row?.content ?? row?.value ?? row?.data ?? '').trim();

      if (!type || !content) return null;

      // "@", "" and bare subdomains all need to be fully qualified for Cloudflare
      const name =
        !rawName || rawName === '@'
          ? domainName
          : rawName.endsWith(domainName)
          ? rawName
          : `${rawName}.${domainName}`;

      const ttl = Number(row?.ttl);
      const priority = Number(row?.priority ?? row?.prio ?? row?.mx_priority);

      return {
        type,
        name,
        content,
        ...(Number.isFinite(ttl) && ttl > 0 && { ttl }),
        ...(Number.isFinite(priority) && { priority }),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

const withZone = (domain: Domain, zone: { id: string; name: string; nameServers: string[] }, extra: Record<string, unknown> = {}) => ({
  cfZoneId: zone.id,
  status: 'ACTIVE' as const,
  customConfig: {
    ...((domain.customConfig as any) || {}),
    cloudflare: { zoneId: zone.id, zoneName: zone.name, nameservers: zone.nameServers, synced: true },
    ...extra,
  },
});

/**
 * A zone that already exists in the Cloudflare account but was never linked
 * to the domain row: link it. Nothing in DNS changes. Null when there is none.
 */
export async function linkExistingCloudflareZone(domain: Domain): Promise<Domain | null> {
  if (domain.cfZoneId) return domain;
  const zone = await findCloudflareZone(domain.name);
  if (!zone) return null;
  return prisma.domain.update({ where: { id: domain.id }, data: withZone(domain, zone) });
}

/**
 * Turn Cloudflare on for a domain. Order matters: snapshot the registrar's records
 * FIRST, copy them into the new zone, and only then repoint the nameservers —
 * otherwise the domain resolves from an empty zone during the cutover.
 */
export async function moveDomainToCloudflare(domain: Domain) {
  const steps: string[] = [];
  const warnings: string[] = [];

  // 1. snapshot whatever the registrar serves today
  let snapshot: any[] = [];
  let rdashDomain = null;

  if (domain.registrar === 'RDASH') {
    rdashDomain = await findRdashDomain(domain.name);
    if (rdashDomain) {
      try {
        snapshot = await getRdashDomainDns(rdashDomain.id);
        steps.push(`Recorded ${snapshot.length} DNS record(s) from RDASH`);
      } catch {
        warnings.push('Could not read the existing DNS records from the registrar');
      }
    } else {
      warnings.push('Domain is marked as registrar-managed but was not found at the registrar');
    }
  }

  // 2. zone first, so there is somewhere to put them
  let zone;
  try {
    zone = await getOrCreateCloudflareZone(domain.name);
  } catch (error: any) {
    throw new Error(`Cloudflare could not create the zone: ${error?.message || 'unknown error'}`);
  }
  if (!zone) {
    throw new Error('Could not create the Cloudflare zone. Check the Cloudflare integration config.');
  }
  steps.push(`Cloudflare zone ready (${zone.id})`);

  // 3. copy the records across
  let importResult = { imported: 0, skipped: 0, failed: [] as string[] };
  if (snapshot.length > 0) {
    importResult = await importDnsRecords(zone.id, toImportableRecords(snapshot, domain.name));
    steps.push(`Copied ${importResult.imported} record(s) into Cloudflare (${importResult.skipped} already present)`);
    if (importResult.failed.length > 0) {
      warnings.push(`Cloudflare rejected: ${importResult.failed.join(', ')}`);
    }
  }

  // 4. only now hand DNS over
  let nameserversUpdated = false;
  if (rdashDomain && zone.nameServers.length > 0) {
    try {
      await updateRdashDomainNameservers(domain.name, { nameservers: zone.nameServers });
      nameserversUpdated = true;
      steps.push(`Pointed the RDASH nameservers at ${zone.nameServers.join(', ')}`);
    } catch (error: any) {
      warnings.push(`Could not update the nameservers at the registrar: ${error?.message || 'unknown error'}`);
    }
  } else if (!rdashDomain) {
    warnings.push(`Set these nameservers at your registrar manually: ${zone.nameServers.join(', ')}`);
  }

  const ssl = await getZoneSslState(zone.id);

  const updated = await prisma.domain.update({
    where: { id: domain.id },
    data: {
      ...withZone(domain, zone, {
        // kept so the pre-cutover DNS is recoverable if the migration goes wrong
        ...(snapshot.length > 0 && { rdashDnsSnapshot: { takenAt: new Date().toISOString(), records: snapshot } }),
      }),
      ...(ssl && { sslStatus: ssl.status, sslExpiry: ssl.expiry }),
    },
  });

  return { domain: updated, zone, steps, warnings, nameserversUpdated, recordsImported: importResult.imported };
}
