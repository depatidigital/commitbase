/**
 * Domain name ideas from a keyword, via OpenAI.
 *
 * The model only proposes names — it is never asked whether one is available,
 * because it cannot know and would happily invent an answer. Availability
 * still comes from the registry, through the same check the manual search uses.
 */

const TIMEOUT_MS = 20000;
const DEFAULT_MODEL = 'gpt-4o-mini';

const label = (domain: string, extensions: string[]): string | null => {
  const name = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  // keep only names on an extension we can actually sell
  const extension = extensions.find((ext) => name.endsWith(`.${ext}`));
  if (!extension) return null;

  const base = name.slice(0, -(extension.length + 1));
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(base) ? name : null;
};

/**
 * Ask for `count` domain ideas for `keyword`, restricted to `extensions` and
 * avoiding anything in `exclude` (names already shown or already taken).
 *
 * Returns an empty list when no API key is configured — the caller reports
 * that as a disabled feature, not an error.
 */
export async function suggestDomains(options: {
  keyword: string;
  extensions: string[];
  /** What the site is for, in the user's own words. Steers the whole list. */
  context?: string;
  exclude?: string[];
  count?: number;
}): Promise<string[]> {
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return [];

  const { keyword, extensions } = options;
  const exclude = options.exclude ?? [];
  const count = options.count ?? 8;

  const context = (options.context ?? '').trim().slice(0, 400);

  /**
   * The user's own words are instructions, not scene-setting: "ubah sinergi dg
   * kata lain" is a directive about how to build the names. They therefore sit
   * above the house rules and are allowed to override them — a fixed rule like
   * "vary the wording" otherwise talks the model out of doing what was asked.
   */
  const system = [
    'You name domains. You propose candidates only — you never claim a name is available.',
    'The user brief outranks the naming guidelines: when they conflict, follow the brief.',
    'Keep the language of the keyword. Indonesian words stay Indonesian — never translate',
    'them to English unless the brief asks for it.',
  ].join(' ');

  const prompt = [
    `Suggest ${count} domain names. Keyword: "${keyword}".`,
    context ? `\nBrief from the user (follow this exactly):\n${context}\n` : '',
    `Use only these extensions: ${extensions.map((ext) => `.${ext}`).join(', ')}.`,
    '',
    'Guidelines (the brief wins if it says otherwise):',
    '- Short and memorable, ideally under 15 characters before the extension.',
    '- Lowercase letters, digits and hyphens only. No spaces, no unicode.',
    '- Vary the extension across the list; do not put every idea on one.',
    '- The keyword may be a compound word. Treat its parts as meaningful and keep the',
    '  parts that carry the meaning unless the brief says to replace them.',
    '- Offer genuinely different names, not the keyword with a digit or filler word bolted on.',
    exclude.length > 0
      ? `- Already suggested, do not repeat: ${exclude.join(', ')}.`
      : '',
    '',
    'Reply as JSON: {"domains": ["example.com", "example.id"]}',
  ]
    .filter(Boolean)
    .join('\n');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 1,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  const payload: any = await response.json();
  const content = payload?.choices?.[0]?.message?.content;

  let parsed: any;
  try {
    parsed = JSON.parse(String(content ?? '{}'));
  } catch {
    throw new Error('OpenAI returned a response that was not JSON');
  }

  const raw: unknown[] = Array.isArray(parsed?.domains) ? parsed.domains : [];
  const excluded = new Set(exclude.map((name) => name.trim().toLowerCase()));

  // the model ignores instructions often enough that every name is re-validated
  return raw
    .map((entry) => (typeof entry === 'string' ? label(entry, extensions) : null))
    .filter((name): name is string => Boolean(name) && !excluded.has(name as string))
    .filter((name, i, all) => all.indexOf(name) === i)
    .slice(0, count);
}
