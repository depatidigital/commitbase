import { Fragment, useState, useSyncExternalStore, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

export type Lang = "bash" | "js" | "python" | "json" | "http";
/** lang defaults from the label: cURL → bash, Node.js / JavaScript → js, Python → python. */
export type Example = { label: string; code: string; lang?: Lang };

const LANG_OF_LABEL: Record<string, Lang> = { curl: "bash", "node.js": "js", javascript: "js", python: "python", json: "json" };

// ponytail: one regex tokenizer instead of a highlighter dependency; enough for the short examples
// shown here (strings, comments, keywords, numbers, curl flags). Prism/Shiki if longer code shows up.
const KEYWORDS: Record<Lang, string[]> = {
  bash: ["curl"],
  js: ["import", "from", "const", "let", "await", "async", "return", "if", "new", "true", "false", "null"],
  python: ["import", "from", "def", "return", "if", "True", "False", "None"],
  json: ["true", "false", "null"],
  http: [],
};
const COLOR = {
  comment: "text-muted-foreground italic",
  string: "text-emerald-700 dark:text-emerald-400",
  keyword: "text-violet-700 dark:text-violet-400",
  number: "text-amber-700 dark:text-amber-400",
  flag: "text-sky-700 dark:text-sky-400",
  call: "text-blue-700 dark:text-blue-400",
  key: "text-sky-700 dark:text-sky-400",
};

function highlight(code: string, lang: Lang): ReactNode[] {
  const never = /(?!)/.source;
  const comment = lang === "js" ? /\/\/[^\n]*/.source : lang === "json" ? never : /(?<![\w/'"])#[^\n]*/.source;
  const words = KEYWORDS[lang].length ? `\\b(?:${KEYWORDS[lang].join("|")})\\b` : never;
  const re = new RegExp(
    [
      `(?<comment>${comment})`,
      `(?<string>${/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/.source})`,
      `(?<keyword>${words})`,
      `(?<number>${/\b\d+(?:\.\d+)?\b/.source})`,
      `(?<flag>${/(?<=\s)--?[A-Za-z][\w-]*/.source})`,
      `(?<call>${/\b[A-Za-z_][\w.]*(?=\()/.source})`,
      // header names: "Authorization:" at a line start
      `(?<key>${lang === "http" ? /^[\w-]+(?=:)/.source : never})`,
    ].join("|"),
    "gm",
  );
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of code.matchAll(re)) {
    const kind = Object.entries(m.groups ?? {}).find(([, v]) => v !== undefined)?.[0] as keyof typeof COLOR | undefined;
    if (!kind || !m[0]) continue;
    if (m.index > last) out.push(<Fragment key={last}>{code.slice(last, m.index)}</Fragment>);
    out.push(
      <span key={m.index} className={COLOR[kind]}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(<Fragment key={last}>{code.slice(last)}</Fragment>);
  return out;
}

// the example language picked last, shared by every CodeExample on the page and remembered
const PICKED_KEY = "larika-code-lang";
const listeners = new Set<() => void>();
let pickedLabel: string | null = null;
const readPicked = () => {
  if (pickedLabel === null) {
    try {
      pickedLabel = localStorage.getItem(PICKED_KEY) ?? "";
    } catch {
      pickedLabel = "";
    }
  }
  return pickedLabel;
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const setPicked = (label: string) => {
  pickedLabel = label;
  try {
    localStorage.setItem(PICKED_KEY, label);
  } catch {
    /* not remembered */
  }
  listeners.forEach((l) => l());
};

/**
 * Code to paste into an app: one block, or tabs (cURL, Node.js…) when there are
 * several; the copy button takes the tab in view. The tab is one switch for the
 * whole panel: picking Node.js once shows Node.js in every example, remembered.
 */
export function CodeExample({ examples }: { examples: Example[] }) {
  const picked = useSyncExternalStore(subscribe, readPicked);
  const [copied, setCopied] = useState(false);
  const current = examples.find((e) => e.label === picked) ?? examples[0];
  if (!current) return null;
  const lang = current.lang ?? LANG_OF_LABEL[current.label.toLowerCase()] ?? "http";

  return (
    <div className="overflow-hidden rounded-md border bg-muted/40">
      <div className="flex items-center gap-1 border-b bg-muted/60 px-2">
        {examples.length > 1 &&
          examples.map((e) => (
            <button
              key={e.label}
              type="button"
              className={`-mb-px border-b-2 px-2.5 py-1.5 text-xs font-medium ${e.label === current.label ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              onClick={() => setPicked(e.label)}
            >
              {e.label}
            </button>
          ))}
        {examples.length === 1 && <span className="py-1.5 text-xs font-medium text-muted-foreground">{current.label}</span>}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-7 w-7 p-0"
          aria-label={t("Copy")}
          onClick={() => {
            void navigator.clipboard.writeText(current.code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
      <pre className="max-h-96 overflow-auto p-3 font-mono text-[11px] leading-relaxed">{highlight(current.code, lang)}</pre>
    </div>
  );
}
