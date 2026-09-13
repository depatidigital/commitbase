import jwt from 'jsonwebtoken';
import type { Domain } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { getGoogleConfigFromDb } from './integrationConfigService';
import { createDnsRecord } from './cloudflareService';

/**
 * Google Search Console for our domains, through a service account — no OAuth
 * redirect dance. The service account proves ownership with a DNS TXT record
 * (Site Verification API), adds the `sc-domain:` property, then names the
 * configured Google accounts as co-owners so it shows up in their own console.
 *
 * Both "Site Verification API" and "Google Search Console API" must be enabled
 * in the service account's Google Cloud project.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = 'https://www.googleapis.com/auth/siteverification https://www.googleapis.com/auth/webmasters';
const VERIFY_API = 'https://www.googleapis.com/siteVerification/v1';
const WEBMASTERS_API = 'https://www.googleapis.com/webmasters/v3';

// the target is ES2020 without DOM typings, same as cloudflareService
const fetchFn: any = (globalThis as any).fetch;

let cached: { email: string; token: string; expiresAt: number } | null = null;

async function accessToken(clientEmail: string, privateKey: string): Promise<string> {
  if (cached?.email === clientEmail && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const assertion = jwt.sign({ scope: SCOPES }, privateKey, {
    algorithm: 'RS256',
    issuer: clientEmail,
    audience: TOKEN_URL,
    expiresIn: 3600,
  });

  const response = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.access_token) {
    throw new Error(data?.error_description || data?.error || `Google refused the service account (HTTP ${response.status})`);
  }

  cached = { email: clientEmail, token: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return data.access_token;
}

async function google(token: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<any> {
  const response = await fetchFn(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error?.message || `Google rejected the request (HTTP ${response.status})`);
  }
  return data;
}

/** After a save: null when the key gets a token, else why not. */
export async function checkGoogleAccess(): Promise<string | null> {
  try {
    const config = await getGoogleConfigFromDb();
    if (!config) return 'No service account key saved';
    cached = null;
    await accessToken(config.clientEmail, config.privateKey);
    return null;
  } catch (error: any) {
    return error?.message || 'Could not reach Google';
  }
}

export const searchConsoleUrl = (siteUrl: string) =>
  `https://search.google.com/search-console?resource_id=${encodeURIComponent(siteUrl)}`;

export type SearchConsoleResult =
  | { verified: true; siteUrl: string; owners: string[]; addedAt: string; consoleUrl: string }
  // not verified yet: the record Google is looking for, and what it said
  | { verified: false; record: { type: 'TXT'; name: string; content: string }; reason: string };

/**
 * Safe to call again: the TXT token is stable per service account and domain,
 * an identical Cloudflare record is left alone, and adding an existing
 * property is a no-op on Google's side.
 */
export async function addDomainToSearchConsole(domain: Domain, extraOwners: string[] = []): Promise<SearchConsoleResult> {
  const config = await getGoogleConfigFromDb();
  if (!config) throw new Error('Google Search Console is not configured. A superadmin sets it under Integrations.');

  const token = await accessToken(config.clientEmail, config.privateKey);
  const site = { type: 'INET_DOMAIN', identifier: domain.name };

  // 1. the TXT value Google wants at the apex
  const { token: txt } = await google(token, 'POST', `${VERIFY_API}/token`, { site, verificationMethod: 'DNS_TXT' });
  const record = { type: 'TXT' as const, name: domain.name, content: String(txt) };

  // 2. on Cloudflare we publish it ourselves; anywhere else the user adds it by hand
  if (domain.cfZoneId) {
    try {
      await createDnsRecord(domain.cfZoneId, record);
    } catch (error: any) {
      if (!/already exists/i.test(error?.message || '')) throw error;
    }
  }

  // 3. ask Google to look. A fresh Cloudflare record is usually visible in seconds, not always.
  let resource: { id: string; owners?: string[] };
  try {
    resource = await google(token, 'POST', `${VERIFY_API}/webResource?verificationMethod=DNS_TXT`, { site });
  } catch (error: any) {
    return { verified: false, record, reason: error?.message || 'Google could not verify the domain yet' };
  }

  // 4. co-owners, so the property appears in their own Search Console
  const owners = [...new Set([...(resource.owners ?? []), ...config.owners, ...extraOwners])];
  if (owners.length > (resource.owners?.length ?? 0)) {
    resource = await google(token, 'PUT', `${VERIFY_API}/webResource/${encodeURIComponent(resource.id)}`, { site, owners });
  }

  // 5. the property itself
  const siteUrl = `sc-domain:${domain.name}`;
  await google(token, 'PUT', `${WEBMASTERS_API}/sites/${encodeURIComponent(siteUrl)}`);

  const searchConsole = { siteUrl, owners: resource.owners ?? owners, addedAt: new Date().toISOString() };
  await prisma.domain.update({
    where: { id: domain.id },
    data: { customConfig: { ...((domain.customConfig as any) || {}), searchConsole } },
  });

  return { verified: true, ...searchConsole, consoleUrl: searchConsoleUrl(siteUrl) };
}
