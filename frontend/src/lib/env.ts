/**
 * Environment variables as the forms edit them: ordered rows, parsed from
 * pasted `.env` text.
 *
 * ponytail: same rules as the backend's parseEnvFile (lib/projectDetect.ts),
 * duplicated because the two packages share no code. Keep them in step.
 */

import type { DetectedProject } from "./applications";

export type EnvRow = { key: string; value: string };

/** What the code expects: .env.example keys without a default, and DATABASE_URL when an ORM is in the deps. */
export function requiredKeys(detected?: DetectedProject | null): Set<string> {
  // PORT/HOST/NODE_ENV come from the platform — never something to fill in
  const keys = new Set(
    (detected?.env.example?.vars ?? []).filter((v) => !v.value && !(v.key in PLATFORM_KEYS)).map((v) => v.key),
  );
  if (detected?.env.needsDatabase) keys.add("DATABASE_URL");
  return keys;
}

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// shipped to the browser by design — a "KEY" in one of these is a publishable key
const PUBLIC_PREFIX = /^(NEXT_PUBLIC_|VITE_|PUBLIC_|NUXT_PUBLIC_|EXPO_PUBLIC_|REACT_APP_)/i;
const SECRET_NAME = /SECRET|KEY|TOKEN|PASSWORD|PASSWD|PASS|PWD|PRIVATE|CREDENTIAL|SALT/i;

/**
 * Set by Larika at runtime — `ignored`: the platform's value always wins (PORT
 * is the one the proxy dials); `override`: a value here replaces the platform's.
 */
export const PLATFORM_KEYS: Record<string, "ignored" | "override"> = {
  PORT: "ignored",
  HOST: "ignored",
  NODE_ENV: "override",
};

/**
 * Variables "Connect database" fills alongside DATABASE_URL, when the app has
 * them: Prisma's DIRECT_URL, Vercel-style POSTGRES_*, Laravel's DB_*, libpq's PG*.
 * Must match the backend's DB_ENV list (routes/databases.ts).
 */
export const DATABASE_KEYS = new Set([
  "DATABASE_URL", "DIRECT_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL_NON_POOLING",
  "DB_CONNECTION", "DB_HOST", "DB_PORT", "DB_DATABASE", "DB_USERNAME", "DB_PASSWORD",
  "PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD",
]);

// Secrets the app itself mints — never a provider's (STRIPE_SECRET_KEY, OPENAI_API_KEY).
const GENERATED_SECRETS = new Set([
  "AUTH_SECRET", "NEXTAUTH_SECRET", "BETTER_AUTH_SECRET", "JWT_SECRET", "JWT_SECRET_KEY", "SESSION_SECRET",
  "COOKIE_SECRET", "CSRF_SECRET", "ENCRYPTION_KEY", "PAYLOAD_SECRET", "SECRET_KEY_BASE", "SECRET_KEY",
  "ADMIN_JWT_SECRET", "API_TOKEN_SALT", "TRANSFER_TOKEN_SALT", "HASH_SALT", "APP_KEY", "APP_KEYS",
]);

const randomBase64 = (bytes = 32) => {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return btoa(String.fromCharCode(...buffer));
};

/**
 * A fresh value for a secret the app mints itself, or null for anything else.
 * Laravel wants `base64:` + 32 bytes; Strapi's APP_KEYS is four of them.
 */
export function generateSecret(key: string): string | null {
  if (!GENERATED_SECRETS.has(key)) return null;
  if (key === "APP_KEY") return `base64:${randomBase64()}`;
  if (key === "APP_KEYS") return Array.from({ length: 4 }, () => randomBase64(16)).join(",");
  return randomBase64();
}

/** What the database form accepts as a name: lowercase letters, digits, underscores. */
export const toDbName = (raw: string) => raw.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);

/**
 * What a DATABASE_URL already says: `postgresql://…/umojati` → PostgreSQL, "umojati".
 * Usually the URL from .env.example or a local setup — its host is not
 * reachable from the node, but its engine and database name are the app's.
 */
export function parseDatabaseUrl(url?: string): { engine?: "POSTGRESQL" | "MYSQL"; name?: string } {
  try {
    const parsed = new URL(url ?? "");
    const engine = /^postgres(ql)?:$/.test(parsed.protocol)
      ? "POSTGRESQL"
      : /^mysql2?:$/.test(parsed.protocol)
        ? "MYSQL"
        : undefined;
    const name = toDbName(decodeURIComponent(parsed.pathname.replace(/^\/+/, "")));
    return { engine, name: name || undefined };
  } catch {
    return {};
  }
}

/**
 * A value pointing at this machine — `postgres://…@localhost:5432`, `http://127.0.0.1:3000`.
 * Usually copied from a local .env: on the node, localhost is the node itself.
 */
export function pointsAtLocalhost(value: string): boolean {
  return /(^|[/@=\s])(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1)(?=[:/?#\s]|$)/i.test(value.trim());
}

// URLs that lead to another service, never to the app itself
const SERVICE_URL = /DATABASE|DB_|_DB|REDIS|MONGO|POSTGRES|MYSQL|AMQP|RABBIT|KAFKA|SMTP|MAIL|S3|STORAGE|BUCKET|CDN|CACHE|QUEUE|WEBHOOK|API/i;

/**
 * The app's own public URL for a variable that should hold it —
 * NEXT_PUBLIC_BASE_URL, BETTER_AUTH_URL, APP_URL… — when it is empty or still
 * the local one (`http://localhost:3000/auth` → `https://<domain>/auth`).
 * null when it holds something else, or names another service.
 */
export function suggestAppUrl(key: string, value: string, domain: string): string | null {
  if (!domain || !/(URL|ORIGIN)$/i.test(key) || SERVICE_URL.test(key)) return null;
  const target = `https://${domain}`;
  if (!value.trim()) return target;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !pointsAtLocalhost(value)) return null;
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return target + path + url.search;
}

/**
 * Masked in the editor: a secret-sounding name. By name only — a URL such as
 * DATABASE_URL stays readable, since its host is what needs checking.
 */
export function isSecret(key: string): boolean {
  return !PUBLIC_PREFIX.test(key) && SECRET_NAME.test(key);
}

/**
 * `.env` text → rows, by dotenv's line rules: `#` comments, `export `,
 * '…' literal, "…" with \n expanded (may span lines), or a bare value up to an
 * inline ` #`. Invalid names are dropped — they could never be exported.
 */
export function parseEnv(text: string): EnvRow[] {
  // [ \t], never \s: `KEY=` with no value must not swallow the next line
  const LINE =
    /^[ \t]*(?:export[ \t]+)?([\w.-]+)[ \t]*=[ \t]*('(?:\\'|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`|[^#\r\n]+)?[ \t]*(?:#.*)?$/gm;
  const rows: EnvRow[] = [];
  for (const match of text.replace(/\r\n?/g, "\n").matchAll(LINE)) {
    const key = match[1]!;
    if (!ENV_NAME.test(key)) continue;
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === "`") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\"/g, '"');
    }
    rows.push({ key, value });
  }
  return rows;
}

/** Later rows win; blank keys dropped. What the API takes. */
export function rowsToEnv(rows: EnvRow[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { key, value } of rows) if (key.trim()) env[key.trim()] = value;
  return env;
}

/** Add rows for keys not there yet — a paste or a prefill never overwrites what was typed. */
export function mergeRows(rows: EnvRow[], incoming: EnvRow[], overwrite = false): EnvRow[] {
  const next = rows.filter((row) => row.key.trim() || row.value);
  for (const row of incoming) {
    const at = next.findIndex((existing) => existing.key === row.key);
    if (at < 0) next.push(row);
    else if (overwrite) next[at] = row;
  }
  return next;
}
