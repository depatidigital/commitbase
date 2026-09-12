/**
 * Environment variables as the forms edit them: ordered rows, parsed from
 * pasted `.env` text.
 *
 * ponytail: same rules as the backend's parseEnvFile (lib/projectDetect.ts),
 * duplicated because the two packages share no code. Keep them in step.
 */

import type { Application, DetectedProject } from "./applications";

export type EnvRow = { key: string; value: string };

/** What the code expects: .env.example keys without a default, and DATABASE_URL when an ORM is in the deps. */
export function requiredKeys(detected?: DetectedProject | null): Set<string> {
  const keys = new Set((detected?.env.example?.vars ?? []).filter((v) => !v.value).map((v) => v.key));
  if (detected?.env.needsDatabase) keys.add("DATABASE_URL");
  return keys;
}

/** Required keys the app's saved env has no value for — what a first deploy would fail on. */
export function missingKeys(application: Application, detected?: DetectedProject | null): string[] {
  const env = application.envVars ?? {};
  return [...requiredKeys(detected)].filter((key) => !env[key]);
}

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// shipped to the browser by design — a "KEY" in one of these is a publishable key
const PUBLIC_PREFIX = /^(NEXT_PUBLIC_|VITE_|PUBLIC_|NUXT_PUBLIC_|EXPO_PUBLIC_|REACT_APP_)/i;
const SECRET_NAME = /SECRET|KEY|TOKEN|PASSWORD|PASSWD|PASS|PWD|PRIVATE|CREDENTIAL|SALT/i;
// scheme://user:password@host — a connection string with its password in it
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s@]+@/i;

/** Masked in the editor: a secret-sounding name, or a URL carrying a password (DATABASE_URL). */
export function isSecret(key: string, value = ""): boolean {
  if (PUBLIC_PREFIX.test(key)) return false;
  return SECRET_NAME.test(key) || URL_WITH_PASSWORD.test(value.trim());
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
