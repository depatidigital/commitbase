import * as crypto from 'crypto';
import * as net from 'net';
import * as vm from 'vm';

/**
 * Email Watcher's pure parts: which messages a rule takes, what it reads out of
 * them, whether the sender is who it says. No IMAP, no database — see
 * emailRules.check.ts.
 */

export type FieldType = 'text' | 'amount';
export type Field = { name: string; pattern: string; type: FieldType };
export type RuleFilter = { fromContains: string; subjectContains: string; bodyContains: string };
export type Message = { from: string; subject: string; text: string };

const has = (haystack: string, needle: string) => !needle.trim() || haystack.toLowerCase().includes(needle.trim().toLowerCase());

/** Every filter a rule sets is a plain, case-insensitive "contains"; an empty one takes anything. */
export const headerMatches = (rule: RuleFilter, m: Pick<Message, 'from' | 'subject'>) =>
  has(m.from, rule.fromContains) && has(m.subject, rule.subjectContains);

export const ruleMatches = (rule: RuleFilter, m: Message) => headerMatches(rule, m) && has(m.text, rule.bodyContains);

/**
 * A rupiah amount as banks write it: "150,000.00", "150.000,00", "150.000", "Rp 1.250.000".
 * The last separator is the decimal point only when two digits or fewer follow it and
 * the other separator also appears, or it appears once with exactly two digits after —
 * "1.500" is fifteen hundred, not one and a half.
 */
export function parseAmount(raw: string): number | null {
  const s = raw.replace(/[^\d.,]/g, '');
  if (!/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  const last = Math.max(lastDot, lastComma);
  let whole = s;
  let fraction = '';
  if (last >= 0) {
    const after = s.slice(last + 1);
    const sep = s[last]!;
    const other = sep === '.' ? ',' : '.';
    const decimal = after.length <= 2 && (s.includes(other) || (s.split(sep).length === 2 && after.length === 2));
    if (decimal) {
      whole = s.slice(0, last);
      fraction = after;
    }
  }
  const value = Number(`${whole.replace(/[.,]/g, '') || '0'}.${fraction || '0'}`);
  return Number.isFinite(value) ? value : null;
}

/**
 * The fields' values: each pattern's first group (the whole match without one), run in a
 * vm with a time limit — a pattern is the user's, and a catastrophic one must not stall
 * the process every watcher shares.
 */
export function extractFields(fields: Field[], text: string): Record<string, string | number | null> {
  if (!fields.length) return {};
  let raw: Array<string | null>;
  try {
    raw = vm.runInNewContext(
      'fields.map(function (f) { var m = new RegExp(f.pattern, "i").exec(text); return m ? (m[1] !== undefined ? m[1] : m[0]) : null; })',
      { fields: fields.map((f) => ({ pattern: f.pattern })), text: text.slice(0, 20_000) },
      { timeout: 200 },
    );
  } catch {
    raw = fields.map(() => null);
  }
  return Object.fromEntries(
    fields.map((f, i) => {
      const value = raw[i] == null ? null : String(raw[i]).trim();
      return [f.name, value !== null && f.type === 'amount' ? parseAmount(value) : value];
    }),
  );
}

/** A rule's fields from the page: names are keys in JSON and {placeholders}, patterns must compile. */
export function validFields(input: unknown): Field[] | string {
  if (!Array.isArray(input) || input.length > 20) return 'Up to 20 fields';
  const fields: Field[] = [];
  for (const f of input) {
    const name = String(f?.name ?? '').trim();
    const pattern = String(f?.pattern ?? '');
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/.test(name)) return `Field name "${name}": letters, digits and _ only`;
    if (!pattern || pattern.length > 500) return `Field "${name}": write a pattern (up to 500 characters)`;
    try {
      new RegExp(pattern, 'i');
    } catch {
      return `Field "${name}": the pattern is not a valid regular expression`;
    }
    if (fields.some((x) => x.name === name)) return `Field "${name}" is listed twice`;
    fields.push({ name, pattern, type: f?.type === 'amount' ? 'amount' : 'text' });
  }
  return fields;
}

/** "{amount} dari {source}" — unknown placeholders are left as written. */
export const renderTemplate = (template: string, vars: Record<string, unknown>) =>
  template.replace(/\{(\w+)\}/g, (all, key: string) => (vars[key] == null ? all : String(vars[key])));

export const webhookSignature = (secret: string, body: string) => crypto.createHmac('sha256', secret).update(body).digest('hex');

/** The first occurrence of a header in a raw message, unfolded; undefined when absent. */
export function firstHeader(source: string, name: string): string | undefined {
  const end = source.search(/\r?\n\r?\n/);
  const head = (end < 0 ? source : source.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ');
  const prefix = `${name.toLowerCase()}:`;
  const line = head.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(prefix));
  return line?.slice(prefix.length).trim();
}

/**
 * The sender is who the From line says: the receiving server's Authentication-Results
 * (the first one — the topmost is the server's own; a sender can forge the ones below
 * it) has DMARC passing, or DKIM passing for the From domain or a parent of it.
 */
export function senderVerified(authResults: string | undefined, fromAddress: string | undefined): boolean {
  const domain = fromAddress?.split('@')[1]?.toLowerCase().trim();
  if (!authResults || !domain) return false;
  const a = authResults.toLowerCase();
  const aligned = (d: string) => domain === d || domain.endsWith(`.${d}`);
  const dmarc = /\bdmarc=pass\b[^;]*?header\.from=([^\s;]+)/.exec(a);
  if (dmarc && aligned(dmarc[1]!)) return true;
  if (/\bdmarc=pass\b/.test(a) && !/header\.from=/.test(a)) return true;
  for (const m of a.matchAll(/\bdkim=pass\b[^;]*?header\.(?:d|i)=@?([^\s;]+)/g)) if (aligned(m[1]!)) return true;
  return false;
}

/** Loopback, private, link-local, CGNAT, unspecified — addresses a user's URL or IMAP host may not point Larika at. */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}
