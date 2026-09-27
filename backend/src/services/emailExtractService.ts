import { extractFields, type Field, type FieldSource, type FieldType, parseAmount, validFields } from '../lib/emailRules';

/**
 * "Extract with AI": the user marks values in a few sample emails and names them; a
 * model writes a regular expression per name; each one is run on the samples and kept
 * only if it reads back what was marked — else the model gets one more try with what
 * went wrong. Nothing is saved here: the page applies the fields it is given.
 *
 * Only parts of the samples go to the model — around the marked values, else the start.
 * Free, up to PER_DAY generations per workspace a day.
 */

export type Label = { name: string; type: FieldType; sample: number; value: string };
export type Check = { name: string; sample: number; expected: string; got: string | number | null; ok: boolean };

const TIMEOUT_MS = 45_000;
/** What each type's values look like, for the model. */
const TYPE_HINT: Record<FieldType, string> = {
  text: 'free text',
  number: 'a number',
  amount: 'money, like 150,000.00 or 1.250.000',
  date: 'a date, maybe with a time',
  code: 'an ID or reference code: letters and/or digits',
};
const DEFAULT_MODEL = 'gpt-4o-mini';
const CONTEXT = 1_200;
const PER_DAY = 100;

// ponytail: in memory, per workspace and UTC day — a restart forgets the counts; a table when it matters
const used = new Map<string, number>();
const today = (organizationId: string) => `${organizationId}:${new Date().toISOString().slice(0, 10)}`;

/** One more generation for a workspace today, or false past the daily limit. */
export function takeGeneration(organizationId: string) {
  const key = today(organizationId);
  const count = used.get(key) ?? 0;
  if (count >= PER_DAY) return false;
  used.set(key, count + 1);
  if (used.size > 1_000) used.delete(used.keys().next().value!);
  return true;
}

/** Hand a generation back — the AI failed, nothing was made. */
export function returnGeneration(organizationId: string) {
  const key = today(organizationId);
  used.set(key, Math.max(0, (used.get(key) ?? 1) - 1));
}

export const generationsLeft = (organizationId: string) => PER_DAY - (used.get(today(organizationId)) ?? 0);

const messageOf = (source: FieldSource, text: string) => ({ from: source === 'from' ? text : '', subject: source === 'subject' ? text : '', text: source === 'body' ? text : '' });

/** What the model sees of a sample: around its first marked value, else its start. */
function excerpt(text: string, labels: Label[]) {
  const at = labels.map((l) => text.indexOf(l.value)).filter((i) => i >= 0);
  if (!at.length) return text.slice(0, CONTEXT * 2);
  const from = Math.max(0, Math.min(...at) - CONTEXT);
  return `${from > 0 ? '…' : ''}${text.slice(from, Math.max(...at) + CONTEXT)}`;
}

/** A value read back matches the marked one: the same text, or the same amount. */
const same = (label: Label, got: string | number | null) =>
  got !== null && (label.type === 'amount' || label.type === 'number' ? got === parseAmount(label.value) : String(got).trim().toLowerCase() === label.value.trim().toLowerCase());

function check(fields: Field[], source: FieldSource, samples: string[], labels: Label[]): Check[] {
  return labels.map((l) => {
    const field = fields.find((f) => f.name === l.name);
    const got = field ? (extractFields([field], messageOf(source, samples[l.sample] ?? ''))[l.name] ?? null) : null;
    return { name: l.name, sample: l.sample, expected: l.value, got, ok: same(l, got) };
  });
}

async function ask(prompt: string): Promise<Array<{ name: string; pattern: string }>> {
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) throw new Error('Extract with AI needs OPENAI_API_KEY to be set');
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_EXTRACT_MODEL || process.env.OPENAI_MODEL || DEFAULT_MODEL,
      messages: [
        {
          role: 'system',
          content: [
            'You write JavaScript regular expressions that read values out of automated emails from one sender (bank and payment notifications).',
            'Each expression runs with the "i" flag on the same part of every email. Its FIRST capture group must be exactly the value, nothing around it.',
            'The values change from email to email; the words around them do not. Anchor on those stable words (labels like "No Referensi:", "dari", "Rp"),',
            'never on the example value itself. Match the value by its shape (digits and separators, a word, a code), so other emails are read too.',
            'Keep each expression short and linear: no nested quantifiers like (a+)+, no lookbehind. Escape the literal characters that need it.',
            'Reply as JSON only: {"fields": [{"name": "<the given name>", "pattern": "<regex without slashes or flags>"}]}',
          ].join(' '),
        },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`The AI did not answer (${response.status}): ${(await response.text()).slice(0, 200)}`);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? '{}') as { fields?: Array<{ name?: unknown; pattern?: unknown }> };
  return (parsed.fields ?? []).map((f) => ({ name: String(f.name ?? ''), pattern: String(f.pattern ?? '') }));
}

/**
 * Patterns for the marked values, checked against the samples. `fields` are the ones to
 * apply (every name, as good as the model got it); `checks` say which marks they read back.
 */
export async function generateFields(source: FieldSource, samples: string[], labels: Label[]) {
  const names = [...new Set(labels.map((l) => l.name))];
  const typeOf = (name: string) => labels.find((l) => l.name === name)!.type;
  const shown = samples.map((text, i) => `### Email ${i + 1}\n${excerpt(text, labels.filter((l) => l.sample === i))}`).join('\n\n');
  const marked = labels.map((l) => `- ${l.name} (${TYPE_HINT[l.type]}) = "${l.value}" (in email ${l.sample + 1})`).join('\n');
  const base = `The ${source === 'from' ? 'sender line' : source} of ${samples.length} email(s):\n\n${shown}\n\nValues to read, with examples:\n${marked}\n\nWrite one expression for each name: ${names.join(', ')}.`;

  const toFields = (answer: Array<{ name: string; pattern: string }>): Field[] =>
    names.map((name) => {
      const pattern = answer.find((a) => a.name === name)?.pattern ?? '';
      const valid = validFields([{ name, pattern, type: typeOf(name), source }]);
      return typeof valid === 'string' ? { name, pattern: '', type: typeOf(name), source } : valid[0]!;
    });

  let fields = toFields(await ask(base));
  let checks = check(fields, source, samples, labels);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    // one more try, told what each pattern read instead
    const feedback = [...new Set(failed.map((c) => c.name))]
      .map((name) => {
        const pattern = fields.find((f) => f.name === name)?.pattern || '(none — it did not compile)';
        const misses = failed.filter((c) => c.name === name).map((c) => `email ${c.sample + 1}: expected "${c.expected}", got ${c.got === null ? 'no match' : `"${c.got}"`}`);
        return `- ${name}: /${pattern}/i → ${misses.join('; ')}`;
      })
      .join('\n');
    const retry = toFields(await ask(`${base}\n\nYour previous expressions did not read these back:\n${feedback}\nFix them. Reply with every name again.`));
    const retried = check(retry, source, samples, labels);
    // per name, keep whichever attempt read back more of its marks
    fields = names.map((name) => {
      const score = (list: Check[]) => list.filter((c) => c.name === name && c.ok).length;
      return score(retried) > score(checks) ? retry.find((f) => f.name === name)! : fields.find((f) => f.name === name)!;
    });
    checks = check(fields, source, samples, labels);
  }
  return {
    fields: fields.filter((f) => f.pattern),
    checks,
    // what the fields read out of every sample, marked or not
    values: samples.map((text) => extractFields(fields.filter((f) => f.pattern), messageOf(source, text))),
  };
}

/** A sample email as the page shows it: its three parts. */
export type Sample = { from: string; subject: string; text: string };

const partOf = (sample: Sample, source: FieldSource) => (source === 'subject' ? sample.subject : source === 'from' ? sample.from : sample.text);

/**
 * Marks made anywhere in the samples — sender, subject or body. Each part's marks get
 * their own patterns (a field reads one part), then the results are put back together.
 */
export async function generateAll(samples: Sample[], labels: Array<Label & { source: FieldSource }>) {
  const sources = [...new Set(labels.map((l) => l.source))];
  const parts = await Promise.all(
    sources.map((source) =>
      generateFields(
        source,
        samples.map((sample) => partOf(sample, source)),
        labels.filter((l) => l.source === source),
      ),
    ),
  );
  return {
    fields: parts.flatMap((p) => p.fields),
    checks: parts.flatMap((p) => p.checks),
    values: samples.map((_, i) => Object.assign({}, ...parts.map((p) => p.values[i]))),
  };
}
