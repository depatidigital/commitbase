import { useRef, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, ChevronLeft, ChevronRight, Loader2, Plus, Sparkles, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { extractWithAi, type ExtractLabel, type ExtractResult, type FieldSource, type FieldType, type PreviewRow, type RuleField } from "@/lib/emailWatcher";
import { t } from "@/lib/i18n";

const COLORS = ["bg-primary/20", "bg-success/25", "bg-warning/30", "bg-destructive/20", "bg-sky-300/40", "bg-fuchsia-300/40"];
const SOURCES: Array<[FieldSource, string]> = [
  ["body", "Body"],
  ["subject", "Subject"],
  ["from", "Sender"],
];

type Mark = ExtractLabel & { start: number; end: number };

const textOf = (row: PreviewRow, source: FieldSource) => (source === "subject" ? row.subject : source === "from" ? row.from : row.text);

/**
 * Extract with AI: the user selects values in a few of the rule's emails and names them;
 * the AI writes a pattern per name, checked against the emails before it is offered.
 */
export function ExtractAiDialog({ mailboxId, rows, onApply, onClose }: { mailboxId: string; rows: PreviewRow[]; onApply: (fields: RuleField[]) => void; onClose: () => void }) {
  const { toast } = useToast();
  const samples = rows.slice(0, 5);
  const [source, setSource] = useState<FieldSource>("body");
  const [at, setAt] = useState(0);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [picked, setPicked] = useState<{ start: number; end: number; value: string } | null>(null);
  const [label, setLabel] = useState<{ name: string; type: FieldType }>({ name: "", type: "text" });
  const [result, setResult] = useState<ExtractResult | null>(null);
  const textRef = useRef<HTMLPreElement>(null);

  const names = [...new Set(marks.map((m) => m.name))];
  const colorOf = (name: string) => COLORS[names.indexOf(name) % COLORS.length];
  const text = samples[at] ? textOf(samples[at]!, source) : "";

  const generate = useMutation({
    mutationFn: () => extractWithAi(mailboxId, { source, samples: samples.map((r) => textOf(r, source)), labels: marks.map(({ name, type, sample, value }) => ({ name, type, sample, value })) }),
    onSuccess: setResult,
    onError: (e: Error) => toast({ title: t("Failed to extract with AI"), description: e.message, variant: "destructive" }),
  });

  /** The selection inside the sample text, as offsets into it. */
  const readSelection = () => {
    const selection = window.getSelection();
    const pre = textRef.current;
    if (!selection || selection.isCollapsed || !pre || !pre.contains(selection.anchorNode) || !pre.contains(selection.focusNode)) return;
    const range = selection.getRangeAt(0);
    const before = document.createRange();
    before.selectNodeContents(pre);
    before.setEnd(range.startContainer, range.startOffset);
    const raw = range.toString();
    const value = raw.trim();
    if (!value || value.length > 300) return;
    const start = before.toString().length + raw.indexOf(value);
    setPicked({ start, end: start + value.length, value });
  };

  const addMark = () => {
    if (!picked || !/^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/.test(label.name)) return;
    // a name keeps its type across samples
    const type = marks.find((m) => m.name === label.name)?.type ?? label.type;
    setMarks([...marks.filter((m) => !(m.sample === at && m.name === label.name)), { ...picked, name: label.name, type, sample: at }]);
    setPicked(null);
    setResult(null);
    window.getSelection()?.removeAllRanges();
  };

  // the sample with its marks (and the pending selection) coloured
  const shown: ReactNode[] = [];
  const spans = [...marks.filter((m) => m.sample === at).map((m) => ({ ...m, pending: false })), ...(picked ? [{ ...picked, name: "", pending: true }] : [])].sort((a, b) => a.start - b.start);
  let pos = 0;
  for (const m of spans) {
    if (m.start < pos) continue;
    shown.push(text.slice(pos, m.start));
    shown.push(
      <mark key={`${m.start}-${m.name}`} className={`rounded px-0.5 text-foreground ${m.pending ? "bg-primary/30 ring-1 ring-primary" : colorOf(m.name)}`} title={m.name}>
        {text.slice(m.start, m.end)}
      </mark>,
    );
    pos = m.end;
  }
  shown.push(text.slice(pos));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            {t("Extract with AI")}
          </DialogTitle>
          <DialogDescription>{t("Select a value in the email, name it, and mark it in another email too if you can. The AI writes the pattern; it is checked on these emails first.")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Select
              value={source}
              onValueChange={(v) => {
                setSource(v as FieldSource);
                setMarks([]);
                setPicked(null);
                setResult(null);
              }}
            >
              <SelectTrigger className="h-8 w-28 text-xs" aria-label={t("Read from")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCES.map(([value, name]) => (
                  <SelectItem key={value} value={value}>
                    {t(name)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2" disabled={at === 0} onClick={() => (setAt(at - 1), setPicked(null))} aria-label={t("Previous email")}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              {t("Email {n} of {total}", { n: at + 1, total: samples.length })}
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2" disabled={at >= samples.length - 1} onClick={() => (setAt(at + 1), setPicked(null))} aria-label={t("Next email")}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </span>
          </div>

          <p className="truncate text-xs text-muted-foreground">{samples[at]?.subject}</p>
          <pre ref={textRef} onMouseUp={readSelection} className="max-h-72 cursor-text select-text overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-sans text-xs leading-relaxed">
            {shown}
          </pre>

          {/* the selection waiting for a name */}
          {picked && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/5 p-2 text-xs">
              <span className="max-w-[12rem] truncate font-mono">“{picked.value}”</span>→
              <Input
                autoFocus
                className="h-8 w-40 font-mono text-xs"
                placeholder="amount"
                list="extract-names"
                value={label.name}
                onChange={(e) => setLabel({ ...label, name: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addMark())}
              />
              <datalist id="extract-names">
                {names.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
              <Select value={label.type} onValueChange={(type) => setLabel({ ...label, type: type as FieldType })}>
                <SelectTrigger className="h-8 w-28 text-xs" aria-label={t("Type")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">{t("Text")}</SelectItem>
                  <SelectItem value="amount">{t("Amount")}</SelectItem>
                </SelectContent>
              </Select>
              <Button type="button" size="sm" className="h-8" disabled={!/^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/.test(label.name)} onClick={addMark}>
                <Plus className="mr-1 h-3 w-3" /> {t("Label")}
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={() => setPicked(null)} aria-label={t("Cancel")}>
                <X className="h-4 w-4" />
              </Button>
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
            <p className="text-xs text-muted-foreground">{t("Select text in the email above to label it.")}</p>
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
              {names.filter((n) => !result.fields.some((f) => f.name === n)).map((n) => (
                <p key={n} className="text-xs text-destructive">
                  {t("No pattern for {name}. Label it in another email and try again.", { name: n })}
                </p>
              ))}
              <p className="text-[11px] text-muted-foreground">{t("{left} left today.", { left: result.left })}</p>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">{t("Parts of these emails are sent to the AI to write the patterns.")}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("Cancel")}
          </Button>
          {result?.fields.length ? (
            <Button onClick={() => (onApply(result.fields), onClose())}>{t("Apply {n} field(s)", { n: result.fields.length })}</Button>
          ) : null}
          <Button variant={result?.fields.length ? "outline" : "default"} disabled={!marks.length || generate.isPending} onClick={() => generate.mutate()}>
            {generate.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
            {result ? t("Generate again") : t("Generate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
