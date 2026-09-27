import * as net from 'net';
import * as vm from 'vm';

/**
 * Email Watcher's pure parts: which messages a rule takes, what it reads out of
 * them, whether the sender is who it says. No IMAP, no database — see
 * emailRules.check.ts.
 */

export type FieldType = 'text' | 'amount';
/** Where a field reads — one part, never a mix, so what it reads and what is marked stay unambiguous. */
export type FieldSource = 'subject' | 'body' | 'from';
export type Field = { name: string; pattern: string; type: FieldType; source?: FieldSource };

/** The text a field's pattern runs on. */
export const sourceText = (m: Message, source: FieldSource = 'body') => (source === 'subject' ? m.subject : source === 'from' ? m.from : m.text);
export type Message = { from: string; subject: string; text: string };

/** What a condition looks at, and how. `in`/`not_in`: a comma-separated list, any of which may appear. */
export const CONDITION_FIELDS = ['from', 'subject', 'body'] as const;
export const CONDITION_OPS = ['contains', 'not_contains', 'equals', 'in', 'not_in', 'regex'] as const;
export type Condition = { field: (typeof CONDITION_FIELDS)[number]; op: (typeof CONDITION_OPS)[number]; value: string };
/** all: every condition (AND); any: at least one (OR). No condition takes every email. */
export type RuleFilter = { match: 'all' | 'any'; conditions: Condition[] };

const NEGATIVE = new Set(['not_contains', 'not_in']);

/** A rule row's filter as the matcher takes it (match is a string column, conditions JSON). */
export const filterOf = (rule: { match: string; conditions: unknown }): RuleFilter => ({
  match: rule.match === 'any' ? 'any' : 'all',
  conditions: Array.isArray(rule.conditions) ? (rule.conditions as Condition[]) : [],
});

/** A user's regular expression, run in a vm with a time limit so a catastrophic one fails the test instead of stalling the process. */
function regexTest(pattern: string, text: string) {
  try {
    return vm.runInNewContext('new RegExp(p, "i").test(t)', { p: pattern, t: text.slice(0, 20_000) }, { timeout: 100 }) === true;
  } catch {
    return false;
  }
}

const listOf = (value: string) =>
  value
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

/** The sender as a condition sees it for "equals": the whole line, the address, the name. */
function senderForms(from: string) {
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from;
  const name = from.replace(/<[^>]*>/, '').replace(/"/g, '').trim();
  return [from, address, name].map((v) => v.trim().toLowerCase());
}

/** One condition on one message part. Case-insensitive throughout. */
export function conditionHolds(c: Condition, m: Message): boolean {
  const text = c.field === 'from' ? m.from : c.field === 'subject' ? m.subject : m.text;
  const lower = text.toLowerCase();
  const value = c.value.trim().toLowerCase();
  switch (c.op) {
    case 'contains':
      return lower.includes(value);
    case 'not_contains':
      return !lower.includes(value);
    case 'equals':
      return (c.field === 'from' ? senderForms(text) : [lower.trim()]).includes(value);
    case 'in':
      return listOf(c.value).some((v) => lower.includes(v));
    case 'not_in':
      return !listOf(c.value).some((v) => lower.includes(v));
    case 'regex':
      return regexTest(c.value.trim(), text);
  }
}

export const ruleMatches = (rule: RuleFilter, m: Message) =>
  !rule.conditions.length || (rule.match === 'any' ? rule.conditions.some((c) => conditionHolds(c, m)) : rule.conditions.every((c) => conditionHolds(c, m)));

/**
 * Whether a message could match from its header alone — before its body is downloaded.
 * A body condition is not known yet, so it counts as "may hold": AND needs every header
 * condition, OR is open as soon as one condition holds or waits on the body.
 */
export function headerMayMatch(rule: RuleFilter, header: Pick<Message, 'from' | 'subject'>) {
  if (!rule.conditions.length) return true;
  const m = { ...header, text: '' };
  const known = (c: Condition) => c.field === 'body' || conditionHolds(c, m);
  return rule.match === 'any' ? rule.conditions.some(known) : rule.conditions.every(known);
}

/** A rule may be on only with a condition that picks emails — not every email, not "everything but". */
export const picksEmails = (rule: RuleFilter) => rule.conditions.some((c) => !NEGATIVE.has(c.op) && c.value.trim());

/** Conditions from the page: known fields and operators, a value, regexes that compile. */
export function validConditions(input: unknown): Condition[] | string {
  if (!Array.isArray(input) || input.length > 20) return 'Up to 20 conditions';
  const conditions: Condition[] = [];
  for (const c of input) {
    const field = c?.field;
    const op = c?.op;
    const value = String(c?.value ?? '').trim();
    if (!CONDITION_FIELDS.includes(field)) return 'A condition looks at the sender, the subject or the body';
    if (!CONDITION_OPS.includes(op)) return `Unknown operator "${op}"`;
    if (!value || value.length > 500) return 'Give each condition a value (up to 500 characters)';
    if (op === 'regex') {
      try {
        new RegExp(value, 'i');
      } catch {
        return `${value} is not a valid regular expression`;
      }
    }
    conditions.push({ field, op, value });
  }
  return conditions;
}

/**
 * IMAP SEARCH terms that narrow a mailbox on the server: only for AND, only plain
 * "contains" on the sender or subject (one each — SEARCH takes one FROM, one SUBJECT).
 * The rest is checked here after the headers are read.
 */
export function searchTerms(rule: RuleFilter): { from?: string | undefined; subject?: string | undefined } {
  if (rule.match !== 'all') return {};
  const first = (field: Condition['field']) => rule.conditions.find((c) => c.field === field && c.op === 'contains')?.value.trim();
  return { ...(first('from') && { from: first('from') }), ...(first('subject') && { subject: first('subject') }) };
}

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
export function extractFields(fields: Field[], m: Message): Record<string, string | number | null> {
  if (!fields.length) return {};
  let raw: Array<string | null>;
  try {
    raw = vm.runInNewContext(
      'fields.map(function (f) { var m = new RegExp(f.pattern, "i").exec(f.text); return m ? (m[1] !== undefined ? m[1] : m[0]) : null; })',
      { fields: fields.map((f) => ({ pattern: f.pattern, text: sourceText(m, f.source).slice(0, 20_000) })) },
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
    const source: FieldSource = f?.source === 'subject' || f?.source === 'from' ? f.source : 'body';
    fields.push({ name, pattern, type: f?.type === 'amount' ? 'amount' : 'text', source });
  }
  return fields;
}

/** "{amount} dari {source}" — unknown placeholders are left as written. */
export const renderTemplate = (template: string, vars: Record<string, unknown>) =>
  template.replace(/\{(\w+)\}/g, (all, key: string) => (vars[key] == null ? all : String(vars[key])));

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
