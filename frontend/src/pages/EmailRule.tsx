import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, FlaskConical, Loader2, Mail, Pencil, Plus, Save, ShieldAlert, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageLayout } from "@/components/PageLayout";
import { CopyField } from "@/components/CopyField";
import { useToast } from "@/hooks/use-toast";
import { deleteRule, getRule, MAILBOXES_KEY, previewRule, RULES_KEY, updateRule, when, type Condition, type ConditionField, type ConditionOp, type PreviewRow, type RuleField, type RuleInput } from "@/lib/emailWatcher";
import { t } from "@/lib/i18n";
import { conditionInvalid, FIELD_LABEL, firstSpan, OP_LABEL, usable } from "@/lib/emailConditions";

const NONE = "none";
const BACK = "/email-watcher?tab=rules";

/** What the page edits: the rule's own settings (its mailbox is fixed). */
const inputOf = (r: RuleInput): RuleInput => ({
  name: r.name,
  match: r.match,
  conditions: r.conditions,
  onlyVerified: r.onlyVerified,
  fields: r.fields,
  webhookUrl: r.webhookUrl,
  waNumberId: r.waNumberId,
  waTo: r.waTo,
  waTemplate: r.waTemplate,
  active: r.active,
});

/** Fields the preview can run: named, with a pattern the browser compiles (the server refuses the others). */
const runnable = (fields: RuleField[]) =>
  fields.filter((f) => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/.test(f.name) || !f.pattern) return false;
    try {
      new RegExp(f.pattern, "i");
      return true;
    } catch {
      return false;
    }
  });

const FILTER_MARK = "bg-yellow-300/70 dark:bg-yellow-500/40";

/** Text with a filter's match marked. */
function Marked({ text, span }: { text: string; span: [number, number] | null }) {
  if (!span) return <>{text}</>;
  return (
    <>
      {text.slice(0, span[0])}
      <mark className={`rounded px-0.5 text-foreground ${FILTER_MARK}`}>{text.slice(span[0], span[1])}</mark>
      {text.slice(span[1])}
    </>
  );
}

/** A line of the body: around a body condition's match when there is one, else its start. */
function bodyLine(text: string, conditions: Condition[]): { text: string; span: [number, number] | null } {
  const flat = text.replace(/\s+/g, " ").trim();
  const span = firstSpan(conditions, "body", flat);
  const from = span ? Math.max(0, span[0] - 40) : 0;
  const line = flat.slice(from, from + 140);
  return { text: `${from > 0 ? "…" : ""}${line}${from + 140 < flat.length ? "…" : ""}`, span: span && [span[0] - from + (from > 0 ? 1 : 0), Math.min(span[1], from + 140) - from + (from > 0 ? 1 : 0)] };
}

/**
 * Patterns to start a field from — picked, then edited freely (any edit makes it Custom).
 * The label ones name the word to look after: change it to what the email says.
 */
type Template = { id: string; label: string; name: string; pattern: string; type: RuleField["type"]; word?: { tail: string; placeholder: string } };
const TEMPLATES: Template[] = [
  { id: "amount", label: "Amount (Rp …)", name: "amount", pattern: "Rp\\.?\\s*([\\d.,]+)", type: "amount" },
  { id: "after-label", label: "Value after a label", name: "destination", pattern: "Tujuan\\s*:?\\s*(.+)", type: "text", word: { tail: "\\s*:?\\s*(.+)", placeholder: "Tujuan" } },
  { id: "word-after", label: "Word after a word", name: "source", pattern: "dari\\s+(\\S+)", type: "text", word: { tail: "\\s+(\\S+)", placeholder: "dari" } },
  { id: "date", label: "Date (20/09/2026, 20 Sep 2026)", name: "date", pattern: "(\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}|\\d{1,2} [A-Za-z]{3,9} \\d{4})", type: "text" },
  { id: "reference", label: "Reference number", name: "reference", pattern: "(?:no\\.?\\s*ref(?:erensi)?|ref(?:erence)?|no\\.?\\s*transaksi|trx\\s*id)\\s*[:#]?\\s*([A-Z0-9-]{6,})", type: "text" },
  { id: "email", label: "Email address", name: "email", pattern: "([\\w.+-]+@[\\w-]+\\.[\\w.]+)", type: "text" },
  { id: "number", label: "First number", name: "number", pattern: "(\\d[\\d.,]*)", type: "text" },
];
const CUSTOM = "custom";
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const unescapeRegex = (pattern: string) => pattern.replace(/\\(.)/g, "$1");
/** A template's pattern around its word: "dari" → dari\s+(\S+). */
const withWord = (tpl: Template, word: string) => (tpl.word ? `${escapeRegex(word)}${tpl.word.tail}` : tpl.pattern);

/** Which template a field's pattern is, and its word for the ones with one; else Custom. */
function templateOf(f: RuleField): { id: string; word: string } {
  for (const tpl of TEMPLATES) {
    if (tpl.type !== f.type) continue;
    if (!tpl.word && tpl.pattern === f.pattern) return { id: tpl.id, word: "" };
    if (tpl.word && f.pattern.endsWith(tpl.word.tail)) {
      const word = unescapeRegex(f.pattern.slice(0, -tpl.word.tail.length));
      if (word && withWord(tpl, word) === f.pattern) return { id: tpl.id, word };
    }
  }
  return { id: CUSTOM, word: "" };
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * A rule's editor: its settings on the left, the mailbox's real emails on the right —
 * which the filters take and what the fields read out of them, redone as you type.
 */
export default function EmailRule() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const key = [...RULES_KEY, id];
  const { data: saved, isLoading, error } = useQuery({ queryKey: key, queryFn: () => getRule(id) });
  const [form, setForm] = useState<RuleInput | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [window, setWindow] = useState({ days: "60", limit: "30" });

  // the form starts from the saved rule, once
  useEffect(() => {
    if (saved && !form) {
      setForm(inputOf(saved));
      setSecret(saved.webhookSecret);
    }
  }, [saved, form]);

  const set = (patch: Partial<RuleInput>) => setForm((f) => f && { ...f, ...patch });
  const dirty = !!saved && !!form && JSON.stringify(inputOf(saved)) !== JSON.stringify(form);

  // the preview follows the filters and fields, 700 ms after the last keystroke
  const probe = useDebounced(
    form
      ? {
          match: form.match,
          conditions: usable(form.conditions).map((c) => ({ ...c, value: c.value.trim() })),
          fields: runnable(form.fields),
          days: Math.min(365, Math.max(1, Number(window.days) || 60)),
          limit: Math.min(100, Math.max(5, Number(window.limit) || 30)),
        }
      : null,
    700,
  );
  // no filter yet: the inbox's newest emails, to pick the filters from
  const canPreview = !!probe;
  const filtered = !!probe && probe.conditions.length > 0;
  const preview = useQuery({
    queryKey: ["email-watcher", "preview", saved?.mailboxId, probe],
    queryFn: () => previewRule(saved!.mailboxId, probe!),
    enabled: !!saved && canPreview,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  });
  const rows = canPreview ? (preview.data?.rows ?? []) : [];
  const current = rows.find((r) => r.uid === selected) ?? rows.find((r) => r.matched) ?? rows[0] ?? null;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: RULES_KEY });
    void queryClient.invalidateQueries({ queryKey: MAILBOXES_KEY });
  };
  const save = useMutation({
    mutationFn: () => updateRule(id, form!),
    onSuccess: (r) => {
      if (r.warning) toast({ title: t("Rule saved"), description: t(r.warning), variant: "destructive" });
      else toast({ title: t("Rule saved") });
      setForm(inputOf(r));
      queryClient.setQueryData(key, (old: typeof saved) => old && { ...old, ...r });
      refresh();
    },
    onError: (e: Error) => toast({ title: t("Failed to save the rule"), description: e.message, variant: "destructive" }),
  });
  // a name is not a filter: renamed on its own, saved at once
  const rename = useMutation({
    mutationFn: (name: string) => updateRule(id, { name }),
    onSuccess: (r) => {
      setRenaming(null);
      set({ name: r.name });
      queryClient.setQueryData(key, (old: typeof saved) => old && { ...old, name: r.name });
      refresh();
    },
    onError: (e: Error) => toast({ title: t("Failed to save the rule"), description: e.message, variant: "destructive" }),
  });
  const rotate = useMutation({ mutationFn: () => updateRule(id, { newSecret: true }), onSuccess: (r) => setSecret(r.webhookSecret) });
  const remove = useMutation({
    mutationFn: () => deleteRule(id),
    onSuccess: () => {
      refresh();
      navigate(BACK);
    },
    onError: (e: Error) => toast({ title: t("Failed to delete the rule"), description: e.message, variant: "destructive" }),
  });

  if (isLoading || (saved && !form)) return <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />;
  if (error || !saved || !form)
    return (
      <p className="flex items-center gap-2 text-sm text-destructive">
        <AlertCircle className="h-4 w-4" />
        {(error as Error)?.message ?? t("Rule not found")}
      </p>
    );

  const fields = form.fields;
  const setField = (i: number, patch: Partial<RuleField>) => set({ fields: fields.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const passed = rows.filter((r) => r.matched).length;

  return (
    <PageLayout
      icon={FlaskConical}
      backTo={BACK}
      title={
        <span className="inline-flex items-center gap-1">
          {form.name || t("Rule")}
          <Button variant="ghost" size="sm" aria-label={t("Rename")} title={t("Rename")} onClick={() => setRenaming(form.name)}>
            <Pencil className="h-4 w-4" />
          </Button>
        </span>
      }
      description={saved.mailbox.email}
      actions={
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={form.active} onCheckedChange={(active) => set({ active })} aria-label={t("Rule on")} />
            {form.active ? t("On") : t("Off")}
          </label>
          <Button variant="outline" onClick={() => setRemoving(true)} aria-label={t("Delete")}>
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            {t("Save")}
          </Button>
        </div>
      }
    >
      <div className="grid gap-6 xl:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]">
        {/* settings */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{t("Filter")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Conditions match={form.match} conditions={form.conditions} onChange={(patch) => set(patch)} />
              <div className="flex items-start gap-3 pt-1">
                <Switch id="rule-verified" checked={form.onlyVerified} onCheckedChange={(onlyVerified) => set({ onlyVerified })} />
                <Label htmlFor="rule-verified" className="font-normal">
                  {t("Only verified senders")}
                  <span className="block text-xs text-muted-foreground">{t("Ignores forged emails (DKIM/DMARC).")}</span>
                </Label>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{t("Fields to read")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-xs text-muted-foreground">{t("Its first group (…) is the value.")}</p>
              {fields.map((f, i) => (
                <div key={i} className="space-y-2 rounded-md border p-3">
                  <div className="flex items-end gap-2">
                    <div className="min-w-0 flex-1 space-y-1">
                      <Label htmlFor={`field-name-${i}`} className="text-xs">
                        {t("Field name")}
                      </Label>
                      <Input id={`field-name-${i}`} className="font-mono" placeholder="amount" value={f.name} onChange={(e) => setField(i, { name: e.target.value })} />
                    </div>
                    <Button type="button" variant="ghost" size="sm" aria-label={t("Remove")} onClick={() => set({ fields: fields.filter((_, j) => j !== i) })}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  {f.name && !/^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/.test(f.name) && <p className="text-xs text-destructive">{t("Letters, digits and _ only, like amount or source")}</p>}
                  <div className="grid grid-cols-[1fr_7rem] gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">{t("Template")}</Label>
                      <Select
                        value={templateOf(f).id}
                        onValueChange={(id) => {
                          const tpl = TEMPLATES.find((x) => x.id === id);
                          if (tpl) setField(i, { pattern: tpl.pattern, type: tpl.type, name: f.name || tpl.name });
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TEMPLATES.map((tpl) => (
                            <SelectItem key={tpl.id} value={tpl.id}>
                              {t(tpl.label)}
                            </SelectItem>
                          ))}
                          <SelectItem value={CUSTOM}>{t("Custom")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t("Type")}</Label>
                      <Select value={f.type} onValueChange={(type) => setField(i, { type: type as RuleField["type"] })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="text">{t("Text")}</SelectItem>
                          <SelectItem value="amount">{t("Amount")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {(() => {
                    const at = templateOf(f);
                    const tpl = TEMPLATES.find((x) => x.id === at.id);
                    return tpl?.word ? (
                      <div className="grid grid-cols-[4.5rem_1fr] items-center gap-2">
                        <Label htmlFor={`field-word-${i}`} className="text-xs">
                          {t("Word")}
                        </Label>
                        <Input
                          id={`field-word-${i}`}
                          placeholder={tpl.word.placeholder}
                          value={at.word}
                          // an empty word would leave the template; keep the placeholder's then
                          onChange={(e) => setField(i, { pattern: withWord(tpl, e.target.value || tpl.word!.placeholder) })}
                        />
                      </div>
                    ) : null;
                  })()}
                  <div className="space-y-1">
                    <Label htmlFor={`field-pattern-${i}`} className="text-xs">
                      {t("Pattern (regex)")}
                    </Label>
                    <Input id={`field-pattern-${i}`} className="font-mono text-xs" placeholder="Rp\s*([\d.,]+)" value={f.pattern} onChange={(e) => setField(i, { pattern: e.target.value })} />
                    {f.pattern && !runnable([{ ...f, name: f.name || "x" }]).length && <p className="text-xs text-destructive">{t("Not a valid regular expression")}</p>}
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={() => set({ fields: [...fields, { name: "", pattern: "", type: "text" }] })}>
                <Plus className="mr-2 h-4 w-4" /> {t("Add field")}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{t("Send to")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="rule-webhook">{t("Webhook URL (optional)")}</Label>
                <Input id="rule-webhook" type="url" placeholder="https://tokoanda.com/api/payment-email" value={form.webhookUrl ?? ""} onChange={(e) => set({ webhookUrl: e.target.value || null })} />
                {secret && (
                  <div className="space-y-1 pt-1">
                    <p className="text-xs text-muted-foreground">{t("Webhook key — sent in x-larika-webhook-key; check it in your app:")}</p>
                    <CopyField value={secret} />
                    <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => rotate.mutate()} disabled={rotate.isPending}>
                      {t("New key")}
                    </Button>
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <Label>{t("WhatsApp (optional)")}</Label>
                {saved.waNumbers.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("Add a number under Whatsapp Gateway API to be notified on WhatsApp.")}</p>
                ) : (
                  <>
                    <Select value={form.waNumberId ?? NONE} onValueChange={(v) => set({ waNumberId: v === NONE ? null : v })}>
                      <SelectTrigger aria-label={t("Send from")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>{t("No WhatsApp")}</SelectItem>
                        {saved.waNumbers.map((n) => (
                          <SelectItem key={n.id} value={n.id}>
                            {t("Send from {name}", { name: n.name })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {form.waNumberId && (
                      <>
                        <Input aria-label={t("Send to")} placeholder="628123456789" value={form.waTo ?? ""} onChange={(e) => set({ waTo: e.target.value || null })} />
                        <Textarea
                          aria-label={t("Message")}
                          rows={2}
                          placeholder={t("{rule}: {subject} — or use your fields, like {amount}")}
                          value={form.waTemplate ?? ""}
                          onChange={(e) => set({ waTemplate: e.target.value || null })}
                        />
                      </>
                    )}
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* the mailbox's real emails */}
        <div className="min-w-0 space-y-4 xl:sticky xl:top-4 xl:self-start">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
              {t("Live matching")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("Real emails, updated as you type. Saved only with Save.")}
            </p>
          </div>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Mail className="h-4 w-4 text-primary" />
                {t("Emails")}
                {preview.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              </CardTitle>
              <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
                {t("Last")}
                <Input aria-label={t("Days")} type="number" min={1} max={365} className="h-7 w-16 text-xs" value={window.days} onChange={(e) => setWindow({ ...window, days: e.target.value })} />
                {t("days, up to")}
                <Input aria-label={t("Emails")} type="number" min={5} max={100} className="h-7 w-16 text-xs" value={window.limit} onChange={(e) => setWindow({ ...window, limit: e.target.value })} />
                {t("emails")}
              </div>
              <p className="text-xs text-muted-foreground">
                {!filtered
                  ? t("Newest inbox emails. Add a filter to narrow them.")
                  : preview.error
                    ? (preview.error as Error).message
                    : t("{passed} of {taken} taken by the rule", { taken: rows.length, passed })}
              </p>
            </CardHeader>
            {canPreview && rows.length > 0 && (
              <CardContent className="p-0">
                {/* one compact block per email, one line each: sender · date, subject, body, what the fields read */}
                <div className="max-h-[26rem] divide-y overflow-y-auto border-t">
                  {rows.map((row) => {
                    const body = bodyLine(row.text, form.conditions);
                    return (
                      <button
                        key={row.uid}
                        type="button"
                        onClick={() => setSelected(row.uid)}
                        className={`block w-full space-y-0.5 px-4 py-2.5 text-left text-xs ${row.uid === current?.uid ? "bg-primary/5" : "hover:bg-muted/50"} ${row.matched ? "" : "opacity-50"}`}
                      >
                        <div className="flex items-center gap-2">
                          {row.verified ? (
                            <CheckCircle2 className="h-3 w-3 shrink-0 text-success" aria-label={t("Verified sender")} />
                          ) : (
                            <ShieldAlert className="h-3 w-3 shrink-0 text-warning" aria-label={t("Sender not verified")} />
                          )}
                          <span className="min-w-0 flex-1 truncate text-muted-foreground">
                            <Marked text={row.from} span={firstSpan(form.conditions, "from", row.from)} />
                          </span>
                          <span className="shrink-0 text-muted-foreground">{when(row.date)}</span>
                        </div>
                        <p className="truncate font-medium">
                          <Marked text={row.subject} span={firstSpan(form.conditions, "subject", row.subject)} />
                        </p>
                        {body.text && (
                          <p className="truncate text-muted-foreground">
                            <Marked text={body.text} span={body.span} />
                          </p>
                        )}
                        {(runnable(fields).length > 0 || !row.matched) && (
                          <div className="flex flex-wrap gap-1.5 pt-1">
                            {!row.matched && <span className="text-muted-foreground">{t("not taken by the rule")}</span>}
                            {runnable(fields).map((f, i) => (
                              <span key={f.name} className={`rounded px-1.5 font-mono ${row.data[f.name] == null ? "bg-destructive/10 text-destructive" : MARKS[i % MARKS.length]}`}>
                                {f.name}: {row.data[f.name] == null ? t("not found") : String(row.data[f.name])}
                              </span>
                            ))}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </CardContent>
            )}
          </Card>

          {canPreview && current && <EmailView row={current} fields={runnable(fields)} filters={form} />}
        </div>
      </div>

      <Dialog open={renaming !== null} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Rename")}</DialogTitle>
          </DialogHeader>
          {renaming !== null && (
            <form
              id="rename-rule"
              onSubmit={(e) => {
                e.preventDefault();
                rename.mutate(renaming.trim());
              }}
            >
              <Label htmlFor="rule-name">{t("Name")}</Label>
              <Input id="rule-name" required autoFocus maxLength={80} value={renaming} onChange={(e) => setRenaming(e.target.value)} />
            </form>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)} disabled={rename.isPending}>
              {t("Cancel")}
            </Button>
            <Button type="submit" form="rename-rule" disabled={rename.isPending}>
              {rename.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={removing} onOpenChange={setRemoving}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Delete {name}?", { name: saved.name })}</DialogTitle>
            <DialogDescription>{t("Its events are deleted with it.")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(false)} disabled={remove.isPending}>
              {t("Cancel")}
            </Button>
            <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
              {remove.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("Delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageLayout>
  );
}

const MARKS = ["bg-primary/20", "bg-success/25", "bg-warning/30", "bg-destructive/20"];

/**
 * One email as the fields read it — subject line, then the text body — with what each
 * field takes marked in its colour. The same patterns the server runs, so what is
 * marked is what is sent.
 */
function EmailView({ row, fields, filters }: { row: PreviewRow; fields: RuleField[]; filters: Pick<RuleInput, "conditions"> }) {
  const text = `${row.subject}\n${row.text}`;
  const marks = useMemo(() => {
    // field -1: a condition's match (subject ones on the subject line, body ones after it)
    const found: Array<{ start: number; end: number; field: number }> = [];
    const subject = firstSpan(filters.conditions, "subject", row.subject);
    if (subject) found.push({ start: subject[0], end: subject[1], field: -1 });
    const body = firstSpan(filters.conditions, "body", row.text);
    if (body) found.push({ start: row.subject.length + 1 + body[0], end: row.subject.length + 1 + body[1], field: -1 });
    fields.forEach((f, field) => {
      try {
        // "d": match indices (ES2022), not in this project's TS lib yet
        const m = new RegExp(f.pattern, "id").exec(text) as (RegExpExecArray & { indices?: Array<[number, number] | undefined> }) | null;
        const at = m?.indices?.[1] ?? m?.indices?.[0];
        if (at && at[1] > at[0]) found.push({ start: at[0], end: at[1], field });
      } catch {
        // an invalid pattern marks nothing
      }
    });
    // overlapping marks: fields before filters, then the earlier one keeps its span
    const kept: typeof found = [];
    for (const m of [...found].sort((a, b) => (a.field < 0 ? 1 : 0) - (b.field < 0 ? 1 : 0))) {
      if (!kept.some((k) => m.start < k.end && k.start < m.end)) kept.push(m);
    }
    return kept.sort((a, b) => a.start - b.start);
  }, [text, fields, filters.conditions, row.subject, row.text]);

  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of marks) {
    if (m.start > at) parts.push(text.slice(at, m.start));
    parts.push(
      <mark key={m.start} className={`rounded px-0.5 text-foreground ${m.field < 0 ? FILTER_MARK : MARKS[m.field % MARKS.length]}`} title={m.field < 0 ? t("Filter") : fields[m.field]!.name}>
        {text.slice(m.start, m.end)}
      </mark>,
    );
    at = m.end;
  }
  parts.push(text.slice(at));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{row.subject}</CardTitle>
        <p className="text-xs text-muted-foreground">
          <Marked text={row.from} span={firstSpan(filters.conditions, "from", row.from)} /> · {when(row.date)}
        </p>
        {fields.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1 text-xs">
            {fields.map((f, i) => (
              <span key={f.name} className={`rounded px-1.5 font-mono ${MARKS[i % MARKS.length]}`}>
                {f.name}: {row.data[f.name] == null ? t("not found") : String(row.data[f.name])}
              </span>
            ))}
          </div>
        )}
      </CardHeader>
      <CardContent>
        <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-sans text-xs leading-relaxed">{parts}</pre>
        {fields.length > 0 && (
          <div className="space-y-1 pt-3">
            <p className="text-xs font-medium">{t("Output")}</p>
            <pre className="overflow-auto rounded-md bg-muted/60 p-3 font-mono text-xs">{JSON.stringify(Object.fromEntries(fields.map((f) => [f.name, row.data[f.name] ?? null])), null, 2)}</pre>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const PLACEHOLDER: Record<ConditionOp, string> = {
  contains: "BNI",
  not_contains: "gagal",
  equals: "noreply@bni.co.id",
  in: "DANA, OVO, GoPay",
  not_in: "promo, newsletter",
  regex: "Rp [\\d.,]+ dari (DANA|OVO)",
};

/** Match all (AND) or any (OR) of a list of conditions, each: [field] [operator] [value]. */
function Conditions({ match, conditions, onChange }: { match: RuleInput["match"]; conditions: Condition[]; onChange: (patch: Pick<RuleInput, "match" | "conditions">) => void }) {
  const update = (i: number, patch: Partial<Condition>) => onChange({ match, conditions: conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {t("Take emails matching")}
        <Select value={match} onValueChange={(m) => onChange({ match: m as RuleInput["match"], conditions })}>
          <SelectTrigger className="h-8 w-auto gap-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("all (AND)")}</SelectItem>
            <SelectItem value="any">{t("any (OR)")}</SelectItem>
          </SelectContent>
        </Select>
        {t("of:")}
      </div>
      {conditions.map((c, i) => (
        <div key={i} className="space-y-1">
          <div className="grid grid-cols-[6rem_8.5rem_minmax(0,1fr)_auto] gap-1.5">
            <Select value={c.field} onValueChange={(field) => update(i, { field: field as ConditionField })}>
              <SelectTrigger className="h-9 px-2 text-xs" aria-label={t("Field")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(FIELD_LABEL) as ConditionField[]).map((f) => (
                  <SelectItem key={f} value={f}>
                    {t(FIELD_LABEL[f])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={c.op} onValueChange={(op) => update(i, { op: op as ConditionOp })}>
              <SelectTrigger className="h-9 px-2 text-xs" aria-label={t("Operator")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(OP_LABEL) as ConditionOp[]).map((op) => (
                  <SelectItem key={op} value={op}>
                    {t(OP_LABEL[op])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input className={`h-9 text-xs ${c.op === "regex" ? "font-mono" : ""}`} aria-label={t("Value")} placeholder={PLACEHOLDER[c.op]} value={c.value} onChange={(e) => update(i, { value: e.target.value })} />
            <Button type="button" variant="ghost" size="sm" className="h-9" aria-label={t("Remove")} onClick={() => onChange({ match, conditions: conditions.filter((_, j) => j !== i) })}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          {conditionInvalid(c) && <p className="text-xs text-destructive">{t("Not a valid regular expression")}</p>}
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange({ match, conditions: [...conditions, { field: conditions.length ? "body" : "from", op: "contains", value: "" }] })}>
        <Plus className="mr-2 h-4 w-4" /> {t("Add condition")}
      </Button>
      {conditions.some((c) => c.op === "in" || c.op === "not_in") && <p className="text-xs text-muted-foreground">{t("One of / none of: a list separated by commas.")}</p>}
    </div>
  );
}
