import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';

/**
 * A hosted site's icon, for the app list and the dashboard: whatever its page
 * declares (<link rel="icon">, then apple-touch-icon), else /favicon.ico. The
 * browser cannot read another site's HTML, so the panel does, and serves the
 * image from its own origin.
 *
 * Public on purpose: an <img> sends no bearer token. Only hosts an app answers
 * on are fetched, so it cannot be pointed at anything else.
 */
const router = Router();

const HIT_MS = 24 * 60 * 60_000;
const MISS_MS = 6 * 60 * 60_000;
const MAX_HTML = 512 * 1024;
const MAX_ICON = 256 * 1024;
// ponytail: in memory, one entry per hosted host — bounded by the apps; a restart refetches
const cache = new Map<string, { at: number; icon: { type: string; body: Buffer } | null }>();

/** The icon hrefs a page declares, best first: rel=icon (and "shortcut icon"), then apple-touch-icon. Pure. */
export function iconLinks(html: string): string[] {
  const icons: string[] = [];
  const touch: string[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase().split(/\s+/) ?? [];
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const url = href?.[1] ?? href?.[2] ?? href?.[3];
    if (!url) continue;
    if (rel.includes('icon')) icons.push(url);
    else if (rel.includes('apple-touch-icon')) touch.push(url);
  }
  return [...icons, ...touch];
}

async function get(url: string, max: number): Promise<{ type: string; body: Buffer } | null> {
  // the page picks the URLs, so https only, every redirect hop too: nothing on
  // loopback or the private network answers with a publicly trusted cert
  // ponytail: no DNS/IP range check; add one if an internal service ever serves https with a public cert
  let res: globalThis.Response | null = null;
  for (let hop = 0; hop < 4; hop++) {
    if (!url.startsWith('https://')) return null;
    res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5_000), headers: { 'user-agent': 'Larika favicon' } }).catch(() => null);
    const next = res && res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!next) break;
    url = new URL(next, url).href;
    res = null;
  }
  if (!res?.ok) return null;
  const body = Buffer.from(await res.arrayBuffer());
  return body.length <= max ? { type: (res.headers.get('content-type') ?? '').split(';')[0]!.trim(), body } : null;
}

async function findIcon(host: string): Promise<{ type: string; body: Buffer } | null> {
  const base = `https://${host}/`;
  const page = await get(base, MAX_HTML);
  const declared = page?.type.includes('html') ? iconLinks(page.body.toString('utf8')) : [];
  for (const href of [...declared, '/favicon.ico']) {
    let url: string;
    try {
      url = new URL(href, base).href;
    } catch {
      continue;
    }
    if (url.startsWith('data:image/')) {
      const [, type = '', data = ''] = /^data:([^;,]+)(?:;base64)?,(.*)$/.exec(url) ?? [];
      if (type && data) return { type, body: Buffer.from(data, url.includes(';base64,') ? 'base64' : 'utf8') };
      continue;
    }
    const icon = await get(url, MAX_ICON);
    // an error page served as 200 is HTML, not an icon
    if (icon && (icon.type.startsWith('image/') || url.endsWith('.ico')) && icon.body.length > 0) {
      return { type: icon.type.startsWith('image/') ? icon.type : 'image/x-icon', body: icon.body };
    }
  }
  return null;
}

router.get('/:host', async (req: Request, res: Response) => {
  // helmet's same-origin default would block even the 404 on the frontend's origin
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  const host = String(req.params.host).toLowerCase();
  const apps = await prisma.appDomain.findMany({ where: { host }, select: { application: { select: { updatedAt: true } } } });
  if (!apps.length) return res.status(404).end();
  // a deploy, restart, upload or start writes the app's status, so updatedAt moves: its icon may have changed
  const changed = Math.max(...apps.map((d) => d.application.updatedAt.getTime()));
  let entry = cache.get(host);
  if (!entry || entry.at < changed || Date.now() - entry.at > (entry.icon ? HIT_MS : MISS_MS)) {
    entry = { at: Date.now(), icon: await findIcon(host).catch(() => null) };
    cache.set(host, entry);
  }
  if (!entry.icon) return res.status(404).end();
  // an SVG opened directly must not run as a page of the panel's origin
  res.set({
    'Content-Type': entry.icon.type,
    'Cache-Control': 'public, max-age=300',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'X-Content-Type-Options': 'nosniff',
  });
  return res.send(entry.icon.body);
});

export default router;
