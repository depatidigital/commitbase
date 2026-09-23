/**
 * Reading an existing nginx configuration, so a box that already serves sites
 * can be adopted instead of rebuilt.
 *
 * Only as much nginx as is needed to answer one question per server block:
 * what does this hostname serve, and can Caddy serve the same thing? Anything
 * this cannot account for becomes a warning on the site rather than a silent
 * omission — the migration preview shows them, and a site with warnings is one
 * a person should look at before it is switched over.
 *
 * Pure: the file contents arrive from the node, nothing here does any I/O.
 */

export type NginxDirective = { name: string; args: string[]; block?: NginxDirective[] };

/**
 * nginx's grammar is `name args... ;` and `name args... { ... }`, with `#`
 * comments to end of line and quoted arguments. That is the whole tokenizer.
 */
export function parseNginx(text: string): NginxDirective[] {
  let i = 0;

  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (text[i] === '#') {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      return;
    }
  };

  const token = (): string | null => {
    skip();
    if (i >= text.length) return null;
    const ch = text[i]!;
    if (ch === '{' || ch === '}' || ch === ';') {
      i++;
      return ch;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let out = '';
      while (i < text.length && text[i] !== quote) {
        // a backslash escapes the next character, quote included
        if (text[i] === '\\' && i + 1 < text.length) i++;
        out += text[i++];
      }
      i++;
      return out;
    }
    let out = '';
    while (i < text.length && !/[\s;{}]/.test(text[i]!)) out += text[i++];
    return out;
  };

  const parseBlock = (depth: number): NginxDirective[] => {
    const out: NginxDirective[] = [];
    let parts: string[] = [];
    for (;;) {
      const t = token();
      if (t === null) break;
      if (t === ';') {
        if (parts.length) out.push({ name: parts[0]!, args: parts.slice(1) });
        parts = [];
        continue;
      }
      if (t === '{') {
        const block = parseBlock(depth + 1);
        out.push({ name: parts[0] ?? '', args: parts.slice(1), block });
        parts = [];
        continue;
      }
      if (t === '}') {
        if (depth === 0) continue; // stray brace: ignore rather than throw
        break;
      }
      parts.push(t);
    }
    if (parts.length) out.push({ name: parts[0]!, args: parts.slice(1) });
    return out;
  };

  return parseBlock(0);
}

/** Every `server { }` block, however deeply it sits under `http { }`. */
export function serverBlocks(directives: NginxDirective[]): NginxDirective[] {
  const out: NginxDirective[] = [];
  const walk = (list: NginxDirective[]) => {
    for (const directive of list) {
      if (directive.name === 'server' && directive.block) out.push(directive);
      else if (directive.block) walk(directive.block);
    }
  };
  walk(directives);
  return out;
}

export type NginxSiteKind = 'proxy' | 'php' | 'static' | 'redirect' | 'unknown';

export type NginxSite = {
  hosts: string[];
  /** ports it listens on, and whether that listener is TLS */
  listens: Array<{ port: number; ssl: boolean }>;
  kind: NginxSiteKind;
  /** proxy: the loopback port it forwards to */
  port?: number;
  /** php / static: the document root */
  root?: string;
  /** php: the FPM socket */
  socket?: string;
  /** static: unknown paths fall back to index.html */
  spa?: boolean;
  /** client_max_body_size, in bytes */
  maxBodyBytes?: number;
  /** proxy_read_timeout, as nginx wrote it */
  readTimeout?: string;
  /** proxy_buffering off — the site streams */
  streaming?: boolean;
  /** what it could not account for; a site with these is one to look at */
  warnings: string[];
};

const SIZE = /^(\d+)([kKmMgG]?)$/;
export function sizeToBytes(raw: string): number | null {
  const match = SIZE.exec(raw.trim());
  if (!match) return null;
  const n = Number(match[1]);
  const unit = (match[2] || '').toLowerCase();
  return unit === 'k' ? n * 1024 : unit === 'm' ? n * 1024 * 1024 : unit === 'g' ? n * 1024 * 1024 * 1024 : n;
}

const first = (block: NginxDirective[], name: string): NginxDirective | undefined => block.find((d) => d.name === name);
const all = (block: NginxDirective[], name: string): NginxDirective[] => block.filter((d) => d.name === name);

/** `http://127.0.0.1:8082` / `http://localhost:8082/` → 8082; anything else → null. */
export function loopbackPort(target: string | undefined): number | null {
  if (!target) return null;
  const match = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})\/?$/.exec(target.trim());
  if (!match) return null;
  const port = Number(match[1]);
  return port > 0 && port < 65536 ? port : null;
}

/**
 * Certbot leaves a companion `:80` block beside every site: redirect to https,
 * otherwise 404. Caddy redirects http to https by itself, so these describe no
 * site of their own and are dropped rather than imported as a host that 404s.
 */
function isRedirectOnly(block: NginxDirective[]): boolean {
  const locations = all(block, 'location');
  const served = locations.some((location) => {
    const inner = location.block ?? [];
    return !!first(inner, 'proxy_pass') || !!first(inner, 'root') || !!first(inner, 'fastcgi_pass') || !!first(inner, 'try_files');
  });
  if (served || first(block, 'root')) return false;
  const returns = all(block, 'return');
  const ifs = all(block, 'if').flatMap((d) => all(d.block ?? [], 'return'));
  return returns.length > 0 || ifs.length > 0;
}

/** What one `server { }` block serves. */
export function siteOf(server: NginxDirective): NginxSite {
  const block = server.block ?? [];
  const warnings: string[] = [];

  const hosts = all(block, 'server_name')
    .flatMap((d) => d.args)
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host && host !== '_' && !host.startsWith('~') && !host.includes('*'));

  const listens = all(block, 'listen').map((d) => {
    const raw = d.args[0] ?? '';
    // 443, [::]:443, 0.0.0.0:443
    const port = Number(/(\d+)\s*$/.exec(raw.split(' ')[0] ?? '')?.[1] ?? 0);
    return { port: port || 80, ssl: d.args.includes('ssl') };
  });

  const site: NginxSite = { hosts, listens, kind: 'unknown', warnings };

  if (isRedirectOnly(block)) return { ...site, kind: 'redirect' };

  const bodySize = first(block, 'client_max_body_size')?.args[0];
  if (bodySize) {
    const bytes = sizeToBytes(bodySize);
    if (bytes === null) warnings.push(`client_max_body_size ${bodySize} could not be read`);
    else site.maxBodyBytes = bytes;
  }

  const locations = all(block, 'location');
  const rootLocation = locations.find((d) => d.args[0] === '/') ?? null;
  const phpLocation = locations.find((d) => /\\?\.php\$?/.test(d.args.join(' ')));
  const root = first(block, 'root')?.args[0] ?? first(rootLocation?.block ?? [], 'root')?.args[0];

  // a proxy to a port on this box — the shape the panel already models
  const proxyPass = first(rootLocation?.block ?? [], 'proxy_pass')?.args[0];
  if (proxyPass) {
    const port = loopbackPort(proxyPass);
    if (port === null) {
      warnings.push(`proxy_pass ${proxyPass} is not a port on this machine, so it cannot be imported`);
      return { ...site, kind: 'unknown' };
    }
    const inner = rootLocation?.block ?? [];
    const readTimeout = first(inner, 'proxy_read_timeout')?.args[0];
    const buffering = first(inner, 'proxy_buffering')?.args[0];
    return {
      ...site,
      kind: 'proxy',
      port,
      ...(readTimeout && { readTimeout }),
      ...(buffering === 'off' && { streaming: true }),
    };
  }

  // PHP through FPM: a document root and a socket
  if (phpLocation && root) {
    const pass = first(phpLocation.block ?? [], 'fastcgi_pass')?.args[0] ?? '';
    const socket = /^unix:(.+)$/.exec(pass)?.[1];
    if (!socket) {
      warnings.push(`fastcgi_pass ${pass || '(missing)'} is not a unix socket, so it cannot be imported`);
      return { ...site, kind: 'unknown', root };
    }
    return { ...site, kind: 'php', root, socket };
  }

  // plain files, with or without a single-page fallback
  if (root) {
    const tryFiles = first(rootLocation?.block ?? [], 'try_files')?.args.join(' ') ?? '';
    return { ...site, kind: 'static', root, ...(/index\.html/.test(tryFiles) && { spa: true }) };
  }

  warnings.push('nothing recognisable is served here');
  return { ...site, kind: 'unknown' };
}

/**
 * Every site in a configuration, with the certbot redirect companions dropped
 * and sites sharing a hostname merged onto the one that actually serves it.
 */
export function sitesOf(text: string): NginxSite[] {
  const sites = serverBlocks(parseNginx(text)).map(siteOf);
  const real = sites.filter((site) => site.kind !== 'redirect' && site.hosts.length > 0);

  // Two blocks for one hostname (the http one redirecting, the https one
  // serving) is certbot's normal shape; anything left over that still collides
  // is worth saying out loud rather than picking one at random.
  const byHost = new Map<string, NginxSite>();
  for (const site of real) {
    for (const host of site.hosts) {
      const existing = byHost.get(host);
      if (existing && existing !== site) {
        site.warnings.push(`${host} is served by more than one server block — only the first is imported`);
        continue;
      }
      byHost.set(host, site);
    }
  }
  return real;
}

/** nginx's directives that change behaviour and that Caddy needs told separately. */
export const CARRIED = ['client_max_body_size', 'proxy_read_timeout', 'proxy_buffering'] as const;
