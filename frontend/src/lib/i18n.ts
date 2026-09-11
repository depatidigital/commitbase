/**
 * Two languages, Indonesian by default.
 *
 * The English text is the key: `t("Sync Apps")`. English needs no dictionary;
 * Indonesian is looked up in src/locales/id/*.ts, one file per area so pages
 * can be translated independently. A string with no entry falls back to the
 * English, so a missed one shows up untranslated rather than broken.
 *
 * ponytail: the language is fixed for the page's lifetime and switching
 * reloads. That is what lets `t()` be a plain function — usable in hooks,
 * toasts and module-level constants with no provider. Move to a context if
 * switching without a reload ever matters.
 */

export type Lang = "id" | "en";

const STORAGE_KEY = "lang";

const read = (): string | null => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

export const lang: Lang = read() === "en" ? "en" : "id";

const dictionary: Record<string, string> = Object.assign(
  {},
  ...Object.values(
    import.meta.glob<{ default: Record<string, string> }>("../locales/id/*.ts", { eager: true }),
  ).map((module) => module.default),
);

if (typeof document !== "undefined") document.documentElement.lang = lang;

const missing = new Set<string>();

/** `t("{count} selected", { count: 3 })` — the English text, or its Indonesian entry. */
export function t(text: string, vars?: Record<string, string | number>): string {
  let out = text;
  if (lang === "id") {
    const hit = dictionary[text];
    if (hit !== undefined) out = hit;
    else if (import.meta.env.DEV && !missing.has(text)) {
      missing.add(text);
      console.warn(`[i18n] no Indonesian for: ${JSON.stringify(text)}`);
    }
  }
  return vars ? out.replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m)) : out;
}

export function setLang(next: Lang) {
  if (next === lang) return;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // storage blocked: nothing to persist, and a reload would land on the default
    return;
  }
  window.location.reload();
}

/** For toLocaleString / Intl calls, so dates and numbers follow the language too. */
export const locale = lang === "id" ? "id-ID" : "en-US";
