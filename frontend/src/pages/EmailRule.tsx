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
import { deleteRule, getRule, MAILBOXES_KEY, previewRule, RULES_KEY, updateRule, when, type PreviewRow, type RuleField, type RuleInput } from "@/lib/emailWatcher";
import { t } from "@/lib/i18n";

const NONE = "none";
const BACK = "/email-watcher?tab=rules";

/** What the page edits: the rule's own settings (its mailbox is fixed). */
const inputOf = (r: RuleInput): RuleInput => ({
  name: r.name,
  fromContains: r.fromContains,
  subjectContains: r.subjectContains,
  bodyContains: r.bodyContains,
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

/** A filter between slashes is a regular expression; else a plain "contains" — as the server reads it. */
const regexOf = (filter: string) => /^\/(.+)\/$/s.exec(filter.trim())?.[1] ?? null;

const filterInvalid = (filter: string) => {
  const pattern = regexOf(filter);
  if (pattern === null) return false;
  try {
    new RegExp(pattern, "i");
    return false;
  } catch {
    return true;
  }
};

/** Where a filter takes the text: [start, end], or null. */
function findFilter(filter: string, text: string): [number, number] | null {
  const needle = filter.trim();
  if (!needle) return null;
  const pattern = regexOf(needle);
  if (pattern === null) {
    const i = text.toLowerCase().indexOf(needle.toLowerCase());
    return i < 0 ? null : [i, i + needle.length];
  }
  try {
    const m = new RegExp(pattern, "i").exec(text);
    return m && m[0].length ? [m.index, m.index + m[0].length] : null;
  } catch {
    return null;
  }
}

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

/** A line of the body: around the body filter's match when there is one, else its start. */
function bodyLine(text: string, filter: string): { text: string; span: [number, number] | null } {
  const flat = text.replace(/\s+/g, " ").trim();
  const span = findFilter(filter, flat);
  const from = span ? Math.max(0, span[0] - 40) : 0;
  const line = flat.slice(from, from + 140);
  return { text: `${from > 0 ? "…" : ""}${line}${from + 140 < flat.length ? "…" : ""}`, span: span && [span[0] - from + (from > 0 ? 1 : 0), Math.min(span[1], from + 140) - from + (from > 0 ? 1 : 0)] };
}

/**
 * Patterns to start a field from — picked, then edited freely (any edit makes it Custom).
 * The label ones name the word to look after: change it to what the email says.
 */
const TEMPLATES: Array<{ id: string; label: string; name: string; pattern: string; type: RuleField["type"] }> = [
  { id: "amount", label: "Amount (Rp …)", name: "amount", pattern: "Rp\\.?\\s*([\\d.,]+)", type: "amount" },
  { id: "after-label", label: "Value after a label (Tujuan: …)", name: "destination", pattern: "Tujuan\\s*:?\\s*(.+)", type: "text" },
  { id: "word-after", label: "Word after “dari”", name: "source", pattern: "dari\\s+(\\S+)", type: "text" },
  { id: "date", label: "Date (20/09/2026, 20 Sep 2026)", name: "date", pattern: "(\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}|\\d{1,2} [A-Za-z]{3,9} \\d{4})", type: "text" },
  { id: "reference", label: "Reference number", name: "reference", pattern: "(?:no\\.?\\s*ref(?:erensi)?|ref(?:erence)?|no\\.?\\s*transaksi|trx\\s*id)\\s*[:#]?\\s*([A-Z0-9-]{6,})", type: "text" },
  { id: "email", label: "Email address", name: "email", pattern: "([\\w.+-]+@[\\w-]+\\.[\\w.]+)", type: "text" },
  { id: "number", label: "First number", name: "number", pattern: "(\\d[\\d.,]*)", type: "text" },
];
const CUSTOM = "custom";
const templateOf = (f: RuleField) => TEMPLATES.find((tpl) => tpl.pattern === f.pattern && tpl.type === f.type)?.id ?? CUSTOM;

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
    form ? { fromContains: form.fromContains.trim(), subjectContains: form.subjectContains.trim(), bodyContains: form.bodyContains.trim(), fields: runnable(form.fields) } : null,
    700,
  );
  // no filter yet: the inbox's newest emails, to pick the filters from
  const canPreview = !!probe;
  const filtered = !!probe && !!(probe.fromContains || probe.subjectContains || probe.bodyContains);
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
              <div className="space-y-1">
                <Label htmlFor="rule-from">{t("Sender (name or email) contains")}</Label>
                <Input id="rule-from" placeholder="BNI · noreply@bni.co.id" value={form.fromContains} onChange={(e) => set({ fromContains: e.target.value })} />
                {filterInvalid(form.fromContains) && <p className="text-xs text-destructive">{t("Not a valid regular expression")}</p>}
              </div>
              <div className="space-y-1">
                <Label htmlFor="rule-subject">{t("Subject contains")}</Label>
                <Input id="rule-subject" placeholder="Transaksi Sebesar" value={form.subjectContains} onChange={(e) => set({ subjectContains: e.target.value })} />
                {filterInvalid(form.subjectContains) && <p className="text-xs text-destructive">{t("Not a valid regular expression")}</p>}
              </div>
              <div className="space-y-1">
                <Label htmlFor="rule-body">{t("Body contains (optional)")}</Label>
                <Input id="rule-body" value={form.bodyContains} onChange={(e) => set({ bodyContains: e.target.value })} />
                {filterInvalid(form.bodyContains) && <p className="text-xs text-destructive">{t("Not a valid regular expression")}</p>}
              </div>
              <p className="text-xs text-muted-foreground">{t("Plain text, or a regular expression between slashes like /Rp [\\d.,]+ dari (DANA|OVO)/. Not case-sensitive. Set the sender or the subject: a rule is not turned on without one.")}</p>
              <div className="flex items-start gap-3 pt-1">
                <Switch id="rule-verified" checked={form.onlyVerified} onCheckedChange={(onlyVerified) => set({ onlyVerified })} />
                <Label htmlFor="rule-verified" className="font-normal">
                  {t("Only verified senders")}
                  <span className="block text-xs text-muted-foreground">
                    {t("Anyone can send an email that says it is from your bank. Keep this on for payments: an email whose sender's domain did not pass DKIM/DMARC is logged but not sent on.")}
                  </span>
                </Label>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{t("Fields to read")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-xs text-muted-foreground">{t("Each field is a regular expression run on the subject and body: its first group (…) is the value. Amount turns “Rp 150,000.00” into 150000.")}</p>
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
                        value={templateOf(f)}
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
              {t("How this rule takes and reads the mailbox's real emails, redone as you type. Yellow: what a filter matched; colours: what each field read. Nothing is saved until you press Save.")}
            </p>
          </div>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Mail className="h-4 w-4 text-primary" />
                {t("Emails of the last 30 days")}
                {preview.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                {!filtered
                  ? t("The newest emails of the inbox. Set the sender or the subject to narrow them to the ones the rule takes.")
                  : preview.error
                    ? (preview.error as Error).message
                    : t("{taken} taken by the sender and subject filters, {passed} also by the body filter. Newest 30; redone as you type.", { taken: rows.length, passed })}
              </p>
            </CardHeader>
            {canPreview && rows.length > 0 && (
              <CardContent className="p-0">
                <div className="max-h-80 overflow-auto border-t">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-card text-left text-muted-foreground">
                      <tr>
                        <th className="p-2">{t("Date")}</th>
                        <th className="p-2">{t("Sender")}</th>
                        <th className="p-2">{t("Subject")}</th>
                        <th className="p-2">{t("Body")}</th>
                        {runnable(fields).map((f) => (
                          <th key={f.name} className="p-2 font-mono">
                            {f.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr
                          key={row.uid}
                          onClick={() => setSelected(row.uid)}
                          className={`cursor-pointer border-t align-top ${row.uid === current?.uid ? "bg-primary/5" : "hover:bg-muted/50"} ${row.matched ? "" : "opacity-50"}`}
                        >
                          <td className="whitespace-nowrap p-2">{when(row.date)}</td>
                          <td className="max-w-[14rem] p-2">
                            <span className="flex items-start gap-1">
                              {row.verified ? (
                                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success" aria-label={t("Verified sender")} />
                              ) : (
                                <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0 text-warning" aria-label={t("Sender not verified")} />
                              )}
                              <span className="break-all">
                                <Marked text={row.from} span={findFilter(form.fromContains, row.from)} />
                              </span>
                            </span>
                          </td>
                          <td className="min-w-[14rem] p-2">
                            <Marked text={row.subject} span={findFilter(form.subjectContains, row.subject)} />
                            {!row.matched && <span className="block text-muted-foreground">{t("left out by the body filter")}</span>}
                          </td>
                          <td className="min-w-[16rem] p-2 text-muted-foreground">
                            {(() => {
                              const line = bodyLine(row.text, form.bodyContains);
                              return line.text ? <Marked text={line.text} span={line.span} /> : "—";
                            })()}
                          </td>
                          {runnable(fields).map((f) => (
                            <td key={f.name} className={`p-2 font-mono ${row.data[f.name] == null ? "text-destructive" : ""}`}>
                              {row.data[f.name] == null ? t("not found") : String(row.data[f.name])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
function EmailView({ row, fields, filters }: { row: PreviewRow; fields: RuleField[]; filters: Pick<RuleInput, "fromContains" | "subjectContains" | "bodyContains"> }) {
  const text = `${row.subject}\n${row.text}`;
  const marks = useMemo(() => {
    // field -1: a filter's match (subject filter on the subject line, body filter after it)
    const found: Array<{ start: number; end: number; field: number }> = [];
    const subject = findFilter(filters.subjectContains, row.subject);
    if (subject) found.push({ start: subject[0], end: subject[1], field: -1 });
    const body = findFilter(filters.bodyContains, row.text);
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
  }, [text, fields, filters.subjectContains, filters.bodyContains, row.subject, row.text]);

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
          <Marked text={row.from} span={findFilter(filters.fromContains, row.from)} /> · {when(row.date)}
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
            <p className="text-xs font-medium">{t("Output — the data this email sends")}</p>
            <pre className="overflow-auto rounded-md bg-muted/60 p-3 font-mono text-xs">{JSON.stringify(Object.fromEntries(fields.map((f) => [f.name, row.data[f.name] ?? null])), null, 2)}</pre>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
