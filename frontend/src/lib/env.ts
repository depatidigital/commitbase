/**
 * Environment variables as the forms edit them: ordered rows, parsed from
 * pasted `.env` text.
 *
 * ponytail: same rules as the backend's parseEnvFile (lib/projectDetect.ts),
 * duplicated because the two packages share no code. Keep them in step.
 */

export type EnvRow = { key: string; value: string };

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
