import { useRef, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, ChevronLeft, ChevronRight, Loader2, MousePointer2, Plus, Sparkles, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { extractWithAi, toFieldName, TYPE_LABEL, type ExtractLabel, type ExtractResult, type FieldSource, type FieldType, type PreviewRow, type RuleField } from "@/lib/emailWatcher";
import { t } from "@/lib/i18n";

const COLORS = ["bg-primary/20", "bg-success/25", "bg-warning/30", "bg-destructive/20", "bg-sky-300/40", "bg-fuchsia-300/40"];
/** The parts of an email, as shown top to bottom — a mark belongs to the one it is made in. */
const PARTS: Array<[FieldSource, string]> = [
  ["from", "Sender"],
  ["subject", "Subject"],
  ["body", "Body"],
];

type Mark = ExtractLabel & { start: number; end: number };
type Picked = { source: FieldSource; start: number; end: number; value: string };

const textOf = (row: PreviewRow, source: FieldSource) => (source === "subject" ? row.subject : source === "from" ? row.from : row.text);

/**
 * Extract with AI: the user selects values anywhere in a few of the rule's emails — the
 * sender, the subject or the body — and names them; the AI writes a pattern per name,
 * checked against the emails before it is offered.
 */
export function ExtractAiDialog({ mailboxId, rows, onApply, onClose }: { mailboxId: string; rows: PreviewRow[]; onApply: (fields: RuleField[]) => void; onClose: () => void }) {
  const { toast } = useToast();
  const samples = rows.slice(0, 5);
  const [at, setAt] = useState(0);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [picked, setPicked] = useState<Picked | null>(null);
  // no type until the user picks one — the AI shapes the pattern by it
  const [label, setLabel] = useState<{ name: string; type: FieldType | "" }>({ name: "", type: "" });
  const [result, setResult] = useState<ExtractResult | null>(null);
  const partRefs = useRef<Partial<Record<FieldSource, HTMLElement | null>>>({});

  const names = [...new Set(marks.map((m) => m.name))];
  const colorOf = (name: string) => COLORS[names.indexOf(name) % COLORS.length];

  const generate = useMutation({
    mutationFn: () =>
      extractWithAi(mailboxId, {
        samples: samples.map((r) => ({ from: r.from, subject: r.subject, text: r.text })),
        labels: marks.map(({ name, type, sample, value, source }) => ({ name, type, sample, value, source })),
      }),
    onSuccess: setResult,
    onError: (e: Error) => toast({ title: t("Failed to extract with AI"), description: e.message, variant: "destructive" }),
  });

  /** The selection, as offsets into the part it was made in. */
  const readSelection = (source: FieldSource) => {
    const selection = window.getSelection();
    const el = partRefs.current[source];
    if (!selection || selection.isCollapsed || !el || !el.contains(selection.anchorNode) || !el.contains(selection.focusNode)) return;
    const range = selection.getRangeAt(0);
    const before = document.createRange();
    before.selectNodeContents(el);
    before.setEnd(range.startContainer, range.startOffset);
    const raw = range.toString();
    const value = raw.trim();
    if (!value || value.length > 300) return;
    const start = before.toString().length + raw.indexOf(value);
    setPicked({ source, start, end: start + value.length, value });
  };

  const addMark = () => {
    const name = toFieldName(label.name);
    // a name keeps its type across samples
    const type = marks.find((m) => m.name === name)?.type ?? label.type;
    if (!picked || !name || !type) return;
    setMarks([...marks.filter((m) => !(m.sample === at && m.name === name)), { ...picked, name, type, sample: at }]);
    setPicked(null);
    setResult(null);
    window.getSelection()?.removeAllRanges();
  };

  /** One part of the current sample, its marks (and the pending selection) coloured. */
  const marked = (source: FieldSource) => {
    const text = samples[at] ? textOf(samples[at]!, source) : "";
    const spans = [
      ...marks.filter((m) => m.sample === at && m.source === source).map((m) => ({ ...m, pending: false })),
      ...(picked?.source === source ? [{ ...picked, name: "", pending: true }] : []),
    ].sort((a, b) => a.start - b.start);
    const out: ReactNode[] = [];
    let pos = 0;
    for (const m of spans) {
      if (m.start < pos) continue;
      out.push(text.slice(pos, m.start));
      out.push(
        <mark key={`${m.start}-${m.name}`} className={`rounded px-0.5 text-foreground ${m.pending ? "bg-primary/30 ring-1 ring-primary" : colorOf(m.name)}`} title={m.name}>
          {text.slice(m.start, m.end)}
        </mark>,
      );
      pos = m.end;
    }
    out.push(text.slice(pos));
    return out;
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-6xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            {t("Extract with AI")}
          </DialogTitle>
          <DialogDescription>{t("Show the AI which values to read; it writes the patterns and checks them on these emails.")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Guide step={result ? 4 : picked ? 2 : marks.length ? 3 : 1} />
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="min-w-0 space-y-2">
              <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  disabled={at === 0}
                  onClick={() => (setAt(at - 1), setPicked(null))}
                  aria-label={t("Previous email")}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                {t("Email {n} of {total}", { n: at + 1, total: samples.length })}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  disabled={at >= samples.length - 1}
                  onClick={() => (setAt(at + 1), setPicked(null))}
                  aria-label={t("Next email")}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>

              {/* the whole email: sender, subject, body — select a value in any of them */}
              <div className="divide-y rounded-md border bg-card text-xs">
                {PARTS.map(([source, name]) => (
                  <div key={source} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 px-3 py-2">
                    <span className="pt-px text-[11px] font-medium text-muted-foreground">{t(name)}</span>
                    <pre
                      ref={(el) => (partRefs.current[source] = el)}
                      onMouseUp={() => readSelection(source)}
                      className={`cursor-text select-text whitespace-pre-wrap break-words font-sans ${source === "body" ? "max-h-52 overflow-auto leading-snug" : "font-medium leading-relaxed"}`}
                    >
                      {marked(source)}
                    </pre>
                  </div>
                ))}
              </div>
            </div>

            {/* beside the email: the selection to name, what is named, what the AI made */}
            <div className="min-w-0 space-y-3 lg:max-h-[22rem] lg:overflow-y-auto">
              {/* the selection waiting for a name */}
              {picked && (
                <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-2.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono">“{picked.value}”</span>
                    <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => setPicked(null)} aria-label={t("Cancel")}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {/* name it (a name used before is offered), pick its type, add */}
                  <Input
                    autoFocus
                    className="h-8 w-full font-mono text-xs"
                    placeholder="amount"
                    list="extract-names"
                    aria-label={t("Field name")}
                    value={label.name}
                    // stored as a key and a {placeholder}: lowercase, _ for spaces, nothing else
                    onChange={(e) => setLabel({ ...label, name: toFieldName(e.target.value) })}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addMark())}
                  />
                  <datalist id="extract-names">
                    {names.map((n) => (
                      <option key={n} value={n} />
                    ))}
                  </datalist>
                  <div className="flex items-center gap-2">
                    <Select value={label.type || undefined} onValueChange={(type) => setLabel({ ...label, type: type as FieldType })}>
                      <SelectTrigger className="h-8 min-w-0 flex-1 text-xs" aria-label={t("Type")}>
                        <SelectValue placeholder={t("Pick a type")} />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(TYPE_LABEL) as FieldType[]).map((type) => (
                              <SelectItem key={type} value={type}>
                                {t(TYPE_LABEL[type])}
                              </SelectItem>
                            ))}
                      </SelectContent>
                    </Select>
                    <Button type="button" size="sm" className="h-8 w-8 shrink-0 p-0" disabled={!label.name || !label.type} onClick={addMark} aria-label={t("Label")} title={t("Label")}>
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}

              {/* what has been marked, per name and email */}
              {marks.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {marks.map((m) => (
                    <span key={`${m.sample}-${m.name}`} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs ${colorOf(m.name)}`}>
                      {m.name} = “{m.value}” <span className="text-muted-foreground">#{m.sample + 1}</span>
                      <button type="button" aria-label={t("Remove")} onClick={() => (setMarks(marks.filter((x) => x !== m)), setResult(null))}>
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t("Select text in the email to label it. Mark it in a second email too: the AI learns what stays the same.")}</p>
              )}

              {/* the AI's patterns, and what they read in every sample */}
              {result && (
                <div className="space-y-2 rounded-md border p-3">
                  {result.fields.map((f) => {
                    const checks = result.checks.filter((c) => c.name === f.name);
                    const ok = checks.every((c) => c.ok);
                    return (
                      <div key={f.name} className="space-y-1">
                        <p className="flex items-center gap-1.5 text-xs font-medium">
                          {ok ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <XCircle className="h-3.5 w-3.5 text-destructive" />}
                          <span className={`rounded px-1 font-mono ${colorOf(f.name)}`}>{f.name}</span>
                          <code className="truncate font-mono text-[11px] text-muted-foreground">{f.pattern}</code>
                        </p>
                        <div className="flex flex-wrap gap-1.5 pl-5 text-[11px]">
                          {result.values.map((v, i) => (
                            <span key={i} className={`rounded px-1.5 font-mono ${v[f.name] == null ? "bg-destructive/10 text-destructive" : "bg-muted"}`}>
                              #{i + 1}: {v[f.name] == null ? t("not found") : String(v[f.name])}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  {names
                    .filter((n) => !result.fields.some((f) => f.name === n))
                    .map((n) => (
                      <p key={n} className="text-xs text-destructive">
                        {t("No pattern for {name}. Label it in another email and try again.", { name: n })}
                      </p>
                    ))}
                </div>
              )}
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t("Free, up to 100 a day. Parts of these emails are sent to the AI to write the patterns.")}
            {result && ` ${t("{left} left today.", { left: result.left })}`}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("Cancel")}
          </Button>
          {result?.fields.length ? <Button onClick={() => (onApply(result.fields), onClose())}>{t("Apply {n} field(s)", { n: result.fields.length })}</Button> : null}
          <Button variant={result?.fields.length ? "outline" : "default"} disabled={!marks.length || generate.isPending} onClick={() => generate.mutate()}>
            {generate.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
            {result ? t("Generate again") : t("Generate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The three steps, each with a small picture of itself: select a value, name it, let the
 * AI write the pattern. `step` is where the user is (4: done) — that one is lit, earlier ones ticked.
 */
function Guide({ step }: { step: number }) {
  const card = (n: number, title: string, picture: ReactNode) => (
    <div className={`flex-1 rounded-lg border p-2.5 transition-colors ${step === n ? "border-primary bg-primary/5" : step > n ? "border-success/40 bg-success/5" : "opacity-60"}`}>
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium">
        <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${step > n ? "bg-success text-white" : "bg-primary/15 text-primary"}`}>
          {step > n ? "✓" : n}
        </span>
        {title}
      </p>
      <div className="flex min-h-[2.75rem] items-center rounded bg-background px-2 py-1.5 text-[11px] leading-snug shadow-sm">{picture}</div>
    </div>
  );
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
      {card(
        1,
        t("Select a value"),
        <span className="relative">
          Pembayaran Berhasil - Rp <span className="rounded-sm bg-primary/30 px-0.5 ring-1 ring-primary">150,000.00</span>
          <MousePointer2 className="absolute -bottom-2 -right-3 h-3.5 w-3.5 fill-foreground text-background" />
        </span>,
      )}
      <ArrowRight className="hidden h-4 w-4 shrink-0 self-center text-muted-foreground sm:block" />
      {card(
        2,
        t("Give it a name"),
        <span className="flex flex-wrap items-center gap-1">
          <span className="font-mono">“150,000.00”</span>→<span className="rounded border px-1 font-mono">amount</span>
          <span className="rounded border px-1">{t("Amount")}</span>
        </span>,
      )}
      <ArrowRight className="hidden h-4 w-4 shrink-0 self-center text-muted-foreground sm:block" />
      {card(
        3,
        t("The AI writes the pattern"),
        <span className="space-y-0.5">
          <code className="block font-mono text-[10px] text-muted-foreground">Rp\s*([\d.,]+)</code>
          <span className="flex gap-1">
            <span className="rounded bg-success/15 px-1 text-success">✓ 150000</span>
            <span className="rounded bg-success/15 px-1 text-success">✓ 600000</span>
          </span>
        </span>,
      )}
    </div>
  );
}
