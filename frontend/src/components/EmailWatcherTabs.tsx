import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FlaskConical, Loader2, Pencil, Plus, RotateCw, ShieldAlert, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { CopyField } from "@/components/CopyField";
import { useToast } from "@/hooks/use-toast";
import {
  createRule,
  deleteRule,
  EVENTS_KEY,
  getEvents,
  getRules,
  MAILBOXES_KEY,
  previewRule,
  replayEvent,
  RULES_KEY,
  updateRule,
  when,
  type EventStatus,
  type Mailbox,
  type MailEvent,
  type PreviewRow,
  type Rule,
  type RuleInput,
  type RulesOverview,
} from "@/lib/emailWatcher";
import { t } from "@/lib/i18n";

const NONE = "none";

/** Rules to start from — only formats seen in real notification emails. */
const PRESETS: Array<{ label: string; rule: Partial<RuleInput> }> = [
  {
    label: "BNI Merchant",
    rule: {
      name: "BNI Merchant",
      fromContains: "BNI",
      subjectContains: "Transaksi Sebesar",
      fields: [
        { name: "amount", pattern: "Rp\\s*([\\d.,]+)", type: "amount" },
        { name: "source", pattern: "dari (\\S+) telah berhasil", type: "text" },
      ],
      waTemplate: "Masuk Rp {amount} dari {source}",
    },
  },
];

const emptyRule = (): RuleInput => ({
  name: "",
  fromContains: "",
  subjectContains: "",
  bodyContains: "",
  onlyVerified: true,
  fields: [],
  webhookUrl: null,
  waNumberId: null,
  waTo: null,
  waTemplate: null,
  active: true,
});

const dataLine = (data: Record<string, unknown>) =>
  Object.entries(data)
    .map(([k, v]) => `${k}: ${v ?? "—"}`)
    .join(" · ");

type Editing = { id: string | null; mailboxId: string; rule: RuleInput; secret?: string };

/** Every rule of the mailboxes the caller manages. */
export function RulesTab({ mailboxes }: { mailboxes: Mailbox[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = useTableQuery(10);
  const { data, isFetching } = useQuery({ queryKey: RULES_KEY, queryFn: getRules, refetchInterval: 30_000 });
  const rules = data?.rules ?? [];
  const managed = mailboxes.filter((m) => m.canManage);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<Rule | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: RULES_KEY });
    // a rule turned on or off starts or stops its mailbox
    void queryClient.invalidateQueries({ queryKey: MAILBOXES_KEY });
  };
  const toggle = useMutation({
    mutationFn: (r: Rule) => updateRule(r.id, { active: !r.active }),
    onSuccess: (r) => {
      if (r.warning) toast({ title: t(r.warning), variant: "destructive" });
      refresh();
    },
    onError: (e: Error) => toast({ title: t("Failed to save the rule"), description: e.message, variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteRule(id),
    onSuccess: () => {
      setRemoving(null);
      refresh();
    },
    onError: (e: Error) => toast({ title: t("Failed to delete the rule"), description: e.message, variant: "destructive" }),
  });

  const columns: Column<Rule>[] = [
    { header: t("Rule"), cell: (r) => <span className="font-medium">{r.name}</span> },
    ...(managed.length > 1 ? [{ header: t("Mailbox"), cell: (r: Rule) => <span className="text-xs">{r.mailbox.email}</span> }] : []),
    {
      header: t("Takes"),
      cell: (r) => (
        <span className="text-xs text-muted-foreground">
          {[r.fromContains && t("from “{v}”", { v: r.fromContains }), r.subjectContains && t("subject “{v}”", { v: r.subjectContains }), r.bodyContains && t("body “{v}”", { v: r.bodyContains })].filter(Boolean).join(", ")}
        </span>
      ),
    },
    { header: t("Reads"), cell: (r) => <span className="font-mono text-xs">{r.fields.map((f) => f.name).join(", ") || "—"}</span> },
    { header: t("Sends to"), cell: (r) => <span className="text-xs">{[r.webhookUrl && "Webhook", r.waNumberId && r.waTo && "WhatsApp"].filter(Boolean).join(" + ") || t("nowhere")}</span> },
    { header: t("On"), cell: (r) => <Switch checked={r.active} onCheckedChange={() => toggle.mutate(r)} aria-label={t("Rule on")} /> },
    {
      header: "",
      className: "w-24 text-right",
      cell: (r) => (
        <>
          <Button variant="ghost" size="sm" aria-label={t("Edit")} onClick={() => setEditing({ id: r.id, mailboxId: r.mailboxId, rule: { ...r }, secret: r.webhookSecret })}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" aria-label={t("Delete")} onClick={() => setRemoving(r)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </>
      ),
    },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        rows={rules}
        rowKey={(r) => r.id}
        query={query}
        filter={(r, search) => `${r.name} ${r.mailbox.email}`.toLowerCase().includes(search.toLowerCase())}
        isLoading={isFetching && !data}
        searchPlaceholder={t("Search rules…")}
        toolbar={
          <Button disabled={!managed[0] || !data} onClick={() => managed[0] && setEditing({ id: null, mailboxId: managed[0].id, rule: emptyRule() })}>
            <Plus className="mr-2 h-4 w-4" /> {t("New rule")}
          </Button>
        }
        empty={managed.length ? t("No rules yet. A rule picks emails by sender and subject and reads values out of them.") : t("Add a mailbox first; its rules show here.")}
      />

      {editing && data && <RuleDialog mailboxes={managed} overview={data} editing={editing} onClose={() => setEditing(null)} onSaved={refresh} />}

      <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Delete {name}?", { name: removing?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("Its events are deleted with it.")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)} disabled={remove.isPending}>
              {t("Cancel")}
            </Button>
            <Button variant="destructive" onClick={() => removing && remove.mutate(removing.id)} disabled={remove.isPending}>
              {remove.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("Delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A rule's form, with a try-it on the last 30 days of real mail before saving. */
function RuleDialog({ mailboxes, overview, editing, onClose, onSaved }: { mailboxes: Mailbox[]; overview: RulesOverview; editing: Editing; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [rule, setRule] = useState<RuleInput>(editing.rule);
  const [mailboxId, setMailboxId] = useState(editing.mailboxId);
  const [secret, setSecret] = useState(editing.secret);
  const [preview, setPreview] = useState<{ scanned: number; rows: PreviewRow[] } | null>(null);
  const set = (patch: Partial<RuleInput>) => setRule((r) => ({ ...r, ...patch }));
  const mailbox = mailboxes.find((m) => m.id === mailboxId);
  // a rule sends from a number of its mailbox's workspace
  const waNumbers = overview.waNumbers.filter((n) => n.organizationId === mailbox?.organization?.id);

  const tryIt = useMutation({
    mutationFn: () => previewRule(mailboxId, rule),
    onSuccess: setPreview,
    onError: (e: Error) => toast({ title: t("Failed to try the rule"), description: e.message, variant: "destructive" }),
  });
  const save = useMutation({
    mutationFn: () => (editing.id ? updateRule(editing.id, rule) : createRule(mailboxId, rule)),
    onSuccess: (saved) => {
      if (saved.warning) toast({ title: t("Rule saved"), description: t(saved.warning), variant: "destructive" });
      onSaved();
      onClose();
    },
    onError: (e: Error) => toast({ title: t("Failed to save the rule"), description: e.message, variant: "destructive" }),
  });
  const rotate = useMutation({
    mutationFn: () => updateRule(editing.id!, { newSecret: true }),
    onSuccess: (r) => {
      setSecret(r.webhookSecret);
      onSaved();
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{editing.id ? t("Edit rule") : t("New rule")}</DialogTitle>
          <DialogDescription>{t("Filters are plain text, not case-sensitive. Each field is a regular expression: its first group (…) is the value.")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            id="email-rule"
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            {!editing.id && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">{t("Start from:")}</span>
                {PRESETS.map((p) => (
                  <Button key={p.label} type="button" size="sm" variant="outline" onClick={() => set(p.rule)}>
                    {p.label}
                  </Button>
                ))}
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-2">
              {/* a rule stays with its mailbox: picked when it is made, when there is a choice */}
              {!editing.id && mailboxes.length > 1 && (
                <div className="space-y-1 md:col-span-2">
                  <Label>{t("Mailbox")}</Label>
                  <Select
                    value={mailboxId}
                    onValueChange={(id) => {
                      setMailboxId(id);
                      setPreview(null);
                      set({ waNumberId: null });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {mailboxes.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor="rule-name">{t("Name")}</Label>
                <Input id="rule-name" required maxLength={80} value={rule.name} onChange={(e) => set({ name: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rule-from">{t("Sender contains")}</Label>
                <Input id="rule-from" placeholder="BNI" value={rule.fromContains} onChange={(e) => set({ fromContains: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rule-subject">{t("Subject contains")}</Label>
                <Input id="rule-subject" placeholder="Transaksi Sebesar" value={rule.subjectContains} onChange={(e) => set({ subjectContains: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rule-body">{t("Body contains (optional)")}</Label>
                <Input id="rule-body" value={rule.bodyContains} onChange={(e) => set({ bodyContains: e.target.value })} />
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t("Fields to read")}</Label>
              {rule.fields.map((f, i) => (
                <div key={i} className="grid grid-cols-[9rem_1fr_8rem_auto] gap-2">
                  <Input aria-label={t("Field name")} placeholder="amount" value={f.name} onChange={(e) => set({ fields: rule.fields.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                  <Input aria-label={t("Pattern")} className="font-mono text-xs" placeholder="Rp\s*([\d.,]+)" value={f.pattern} onChange={(e) => set({ fields: rule.fields.map((x, j) => (j === i ? { ...x, pattern: e.target.value } : x)) })} />
                  <Select value={f.type} onValueChange={(type) => set({ fields: rule.fields.map((x, j) => (j === i ? { ...x, type: type as "text" | "amount" } : x)) })}>
                    <SelectTrigger aria-label={t("Type")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="text">{t("Text")}</SelectItem>
                      <SelectItem value="amount">{t("Amount")}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button type="button" variant="ghost" size="sm" aria-label={t("Remove")} onClick={() => set({ fields: rule.fields.filter((_, j) => j !== i) })}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={() => set({ fields: [...rule.fields, { name: "", pattern: "", type: "text" }] })}>
                <Plus className="mr-2 h-4 w-4" /> {t("Add field")}
              </Button>
            </div>

            <div className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">{t("Try it on the last 30 days")}</p>
                <Button type="button" size="sm" variant="secondary" onClick={() => tryIt.mutate()} disabled={tryIt.isPending || (!rule.fromContains.trim() && !rule.subjectContains.trim())}>
                  {tryIt.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FlaskConical className="mr-2 h-4 w-4" />}
                  {t("Try")}
                </Button>
              </div>
              {preview &&
                (preview.rows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("No email in the last 30 days matches. Loosen the filters.")}</p>
                ) : (
                  <div className="max-h-72 overflow-auto">
                    <table className="w-full text-xs">
                      <thead className="text-left text-muted-foreground">
                        <tr>
                          <th className="p-1">{t("Date")}</th>
                          <th className="p-1">{t("Subject")}</th>
                          {rule.fields.map((f) => (
                            <th key={f.name} className="p-1 font-mono">
                              {f.name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.map((row) => (
                          <tr key={row.uid} className="border-t align-top">
                            <td className="whitespace-nowrap p-1">{when(row.date)}</td>
                            <td className="p-1">
                              <span className="flex items-start gap-1">
                                {row.verified ? <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success" aria-label={t("Verified sender")} /> : <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0 text-warning" aria-label={t("Sender not verified")} />}
                                {row.subject}
                              </span>
                            </td>
                            {rule.fields.map((f) => (
                              <td key={f.name} className={`p-1 font-mono ${row.data[f.name] == null ? "text-destructive" : ""}`}>
                                {row.data[f.name] == null ? t("not found") : String(row.data[f.name])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
            </div>

            <div className="flex items-start gap-3">
              <Switch id="rule-verified" checked={rule.onlyVerified} onCheckedChange={(onlyVerified) => set({ onlyVerified })} />
              <Label htmlFor="rule-verified" className="font-normal">
                {t("Only verified senders")}
                <span className="block text-xs text-muted-foreground">{t("Anyone can send an email that says it is from your bank. Keep this on for payments: an email whose sender's domain did not pass DKIM/DMARC is logged but not sent on.")}</span>
              </Label>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="rule-webhook">{t("Webhook URL (optional)")}</Label>
                <Input id="rule-webhook" type="url" placeholder="https://tokoanda.com/api/payment-email" value={rule.webhookUrl ?? ""} onChange={(e) => set({ webhookUrl: e.target.value || null })} />
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
                {waNumbers.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("Add a number under Whatsapp Gateway API to be notified on WhatsApp.")}</p>
                ) : (
                  <>
                    <Select value={rule.waNumberId ?? NONE} onValueChange={(v) => set({ waNumberId: v === NONE ? null : v })}>
                      <SelectTrigger aria-label={t("Send from")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>{t("No WhatsApp")}</SelectItem>
                        {waNumbers.map((n) => (
                          <SelectItem key={n.id} value={n.id}>
                            {t("Send from {name}", { name: n.name })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {rule.waNumberId && (
                      <>
                        <Input aria-label={t("Send to")} placeholder="628123456789" value={rule.waTo ?? ""} onChange={(e) => set({ waTo: e.target.value || null })} />
                        <Textarea
                          aria-label={t("Message")}
                          rows={2}
                          placeholder={t("{rule}: {subject} — or use your fields, like {amount}")}
                          value={rule.waTemplate ?? ""}
                          onChange={(e) => set({ waTemplate: e.target.value || null })}
                        />
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            {t("Cancel")}
          </Button>
          <Button type="submit" form="email-rule" disabled={save.isPending || !mailboxId}>
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const STATUS: Record<EventStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  DELIVERED: { label: "Sent", variant: "default" },
  PENDING: { label: "Retrying", variant: "secondary" },
  FAILED: { label: "Failed", variant: "destructive" },
  SKIPPED: { label: "Sender not verified", variant: "outline" },
  NO_TARGET: { label: "Logged only", variant: "outline" },
};

/** What the rules of every managed mailbox matched, newest first, with a send-again for failures. */
export function EventsTab({ manyMailboxes }: { manyMailboxes: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = useTableQuery(25);
  const { data, isFetching } = useQuery({ queryKey: [...EVENTS_KEY, query.params], queryFn: () => getEvents(query.params), refetchInterval: 15_000, placeholderData: keepPreviousData });
  // the retention the server keeps events for — the rules overview says it
  const { data: overview } = useQuery({ queryKey: RULES_KEY, queryFn: getRules });
  const replay = useMutation({
    mutationFn: replayEvent,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: EVENTS_KEY }),
    onError: (e: Error) => toast({ title: t("Failed to send the event again"), description: e.message, variant: "destructive" }),
  });

  const columns: Column<MailEvent>[] = [
    { header: t("Received"), cell: (e) => <span className="whitespace-nowrap">{when(e.receivedAt)}</span> },
    {
      header: t("Rule"),
      cell: (e) => (
        <div>
          <p>{e.rule.name}</p>
          {manyMailboxes && <p className="text-xs text-muted-foreground">{e.rule.mailbox.email}</p>}
        </div>
      ),
    },
    {
      header: t("Email"),
      cell: (e) => (
        <div className="max-w-md">
          <p className="truncate" title={e.subject}>
            {e.subject}
          </p>
          <p className="truncate text-xs text-muted-foreground">{e.from}</p>
        </div>
      ),
    },
    { header: t("Read"), cell: (e) => <span className="font-mono text-xs">{dataLine(e.data)}</span> },
    {
      header: t("Status"),
      cell: (e) => (
        <div className="space-y-1">
          <Badge variant={STATUS[e.status]?.variant ?? "outline"}>{t(STATUS[e.status]?.label ?? e.status)}</Badge>
          {e.error && <p className="max-w-xs text-xs text-destructive">{e.error}</p>}
        </div>
      ),
    },
    {
      header: "",
      className: "w-12 text-right",
      cell: (e) =>
        e.status !== "SKIPPED" && e.status !== "NO_TARGET" ? (
          <Button variant="ghost" size="sm" aria-label={t("Send again")} title={t("Send again")} disabled={replay.isPending} onClick={() => replay.mutate(e.id)}>
            <RotateCw className="h-4 w-4" />
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{t("Emails your rules matched, kept {days} days. Failed sends are retried for about 9 hours.", { days: overview?.retentionDays ?? 90 })}</p>
      <DataTable
        columns={columns}
        rows={data?.data ?? []}
        rowKey={(e) => e.id}
        query={query}
        pagination={data?.pagination}
        isLoading={isFetching && !data}
        searchPlaceholder={t("Search subject or sender…")}
        empty={t("Nothing matched yet. New emails show here within seconds of arriving.")}
      />
    </div>
  );
}
