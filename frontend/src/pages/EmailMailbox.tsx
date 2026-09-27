import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, FlaskConical, KeyRound, List, Loader2, MailSearch, Pause, Pencil, Play, Plus, RotateCw, ShieldAlert, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { CopyField } from "@/components/CopyField";
import { useToast } from "@/hooks/use-toast";
import {
  createRule,
  deleteMailbox,
  deleteRule,
  getEvents,
  getMailbox,
  previewRule,
  replayEvent,
  updateMailbox,
  updateRule,
  MAILBOXES_KEY,
  when,
  type EventStatus,
  type MailboxDetail,
  type MailEvent,
  type PreviewRow,
  type Rule,
  type RuleInput,
} from "@/lib/emailWatcher";
import { MailboxStatusBadge, PasswordGuide } from "@/pages/EmailWatcher";
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

/** One watched mailbox: its connection, its rules and what they matched. Owners and admins. */
export default function EmailMailbox() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const key = ["email-watcher", "mailbox", id];
  const { data: box, isLoading, error } = useQuery({ queryKey: key, queryFn: () => getMailbox(id), refetchInterval: 30_000 });
  const [editing, setEditing] = useState<{ id: string | null; rule: RuleInput; secret?: string } | null>(null);
  const [password, setPassword] = useState<{ host: string; port: string; username: string; password: string } | null>(null);
  const [removing, setRemoving] = useState<"mailbox" | Rule | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: key });
    void queryClient.invalidateQueries({ queryKey: MAILBOXES_KEY });
  };
  const failed = (title: string) => (e: Error) => toast({ title, description: e.message, variant: "destructive" });

  const pause = useMutation({ mutationFn: (paused: boolean) => updateMailbox(id, { paused }), onSuccess: refresh, onError: failed(t("Failed to update the mailbox")) });
  const login = useMutation({
    mutationFn: () => updateMailbox(id, { host: password!.host, port: Number(password!.port) || 993, secure: (Number(password!.port) || 993) === 993, username: password!.username, password: password!.password }),
    onSuccess: () => {
      setPassword(null);
      refresh();
    },
    onError: failed(t("Failed to update the mailbox")),
  });
  const remove = useMutation({
    mutationFn: async () => {
      if (removing === "mailbox") {
        await deleteMailbox(id);
        navigate("/email-watcher");
      } else if (removing) await deleteRule(removing.id);
    },
    onSuccess: () => {
      setRemoving(null);
      refresh();
    },
    onError: failed(t("Failed to delete")),
  });
  const toggle = useMutation({
    mutationFn: (r: Rule) => updateRule(r.id, { active: !r.active }),
    onSuccess: (r) => {
      if (r.warning) toast({ title: t(r.warning), variant: "destructive" });
      refresh();
    },
    onError: failed(t("Failed to save the rule")),
  });

  const ruleQuery = useTableQuery(10);
  const ruleColumns: Column<Rule>[] = [
    { header: t("Rule"), cell: (r) => <span className="font-medium">{r.name}</span> },
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
    { header: t("On"), cell: (r) => <Switch checked={r.active} onCheckedChange={() => toggle.mutate(r)} onClick={(e) => e.stopPropagation()} aria-label={t("Rule on")} /> },
    {
      header: "",
      className: "w-24 text-right",
      cell: (r) => (
        <>
          <Button variant="ghost" size="sm" aria-label={t("Edit")} onClick={() => setEditing({ id: r.id, rule: { ...r }, secret: r.webhookSecret })}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" aria-label={t("Delete")} onClick={() => setRemoving(r)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </>
      ),
    },
  ];

  if (isLoading) return <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />;
  if (error || !box)
    return (
      <p className="flex items-center gap-2 text-sm text-destructive">
        <AlertCircle className="h-4 w-4" />
        {(error as Error)?.message ?? t("Mailbox not found")}
      </p>
    );

  return (
    <PageLayout
      icon={MailSearch}
      backTo="/email-watcher"
      title={box.email}
      description={`${box.host}:${box.port} · ${t("last checked {when}", { when: when(box.lastCheckedAt) })}`}
      actions={
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => pause.mutate(box.status !== "PAUSED")} disabled={pause.isPending}>
            {box.status === "PAUSED" ? <Play className="mr-2 h-4 w-4" /> : <Pause className="mr-2 h-4 w-4" />}
            {box.status === "PAUSED" ? t("Resume") : t("Pause")}
          </Button>
          <Button variant="outline" onClick={() => setPassword({ host: box.host, port: String(box.port), username: box.username, password: "" })}>
            <KeyRound className="mr-2 h-4 w-4" /> {t("Login")}
          </Button>
          <Button variant="outline" onClick={() => setRemoving("mailbox")} aria-label={t("Delete mailbox")}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <MailboxStatusBadge status={box.status} />
        {box.status === "OK" && !box.rules.some((r) => r.active) && <span className="text-sm text-muted-foreground">{t("Not connected until a rule is on.")}</span>}
        {box.lastError && box.status !== "OK" && <span className="text-sm text-destructive">{box.lastError}</span>}
        {box.status === "AUTH_FAILED" && (
          <Button size="sm" onClick={() => setPassword({ host: box.host, port: String(box.port), username: box.username, password: "" })}>
            {t("Enter a new password")}
          </Button>
        )}
      </div>

      <Tabs defaultValue="rules" className="space-y-4">
        <TabsList>
          <TabsTrigger value="rules">
            <FlaskConical className="mr-2 h-4 w-4" />
            {t("Rules")} {box.rules.length > 0 && `(${box.rules.length})`}
          </TabsTrigger>
          <TabsTrigger value="events">
            <List className="mr-2 h-4 w-4" />
            {t("Events")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="rules" className="space-y-3">
          <div className="flex justify-end">
            <Button onClick={() => setEditing({ id: null, rule: emptyRule() })}>
              <Plus className="mr-2 h-4 w-4" /> {t("New rule")}
            </Button>
          </div>
          <DataTable
            columns={ruleColumns}
            rows={box.rules}
            rowKey={(r) => r.id}
            query={ruleQuery}
            filter={(r, search) => r.name.toLowerCase().includes(search.toLowerCase())}
            searchPlaceholder={t("Search rules…")}
            empty={t("No rules yet. A rule picks emails by sender and subject and reads values out of them.")}
          />
        </TabsContent>
        <TabsContent value="events">
          <EventsTab mailboxId={box.id} retentionDays={box.retentionDays} />
        </TabsContent>
      </Tabs>

      {editing && <RuleDialog box={box} editing={editing} onClose={() => setEditing(null)} onSaved={refresh} />}

      <Dialog open={!!password} onOpenChange={(o) => !o && setPassword(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Login for {email}", { email: box.email })}</DialogTitle>
            <DialogDescription>{t("Tested before it is saved. The watcher reconnects with it and reads what arrived meanwhile.")}</DialogDescription>
          </DialogHeader>
          {password && (
            <form
              id="mailbox-login"
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                login.mutate();
              }}
            >
              <PasswordGuide provider={box.host.includes("gmail") ? "gmail" : box.host.includes("yahoo") ? "yahoo" : box.host.includes("me.com") ? "me" : null} />
              <div className="grid grid-cols-[1fr_6rem] gap-2">
                <div className="space-y-1">
                  <Label htmlFor="login-host">{t("IMAP server")}</Label>
                  <Input id="login-host" required value={password.host} onChange={(e) => setPassword({ ...password, host: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="login-port">{t("Port")}</Label>
                  <Input id="login-port" type="number" required value={password.port} onChange={(e) => setPassword({ ...password, port: e.target.value })} />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="login-username">{t("Username")}</Label>
                <Input id="login-username" required value={password.username} onChange={(e) => setPassword({ ...password, username: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="login-password">{t("Password or app password")}</Label>
                <Input id="login-password" type="password" required autoFocus autoComplete="off" value={password.password} onChange={(e) => setPassword({ ...password, password: e.target.value })} />
              </div>
            </form>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPassword(null)} disabled={login.isPending}>
              {t("Cancel")}
            </Button>
            <Button type="submit" form="mailbox-login" disabled={login.isPending}>
              {login.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("Test and save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{removing === "mailbox" ? t("Delete {name}?", { name: box.email }) : t("Delete {name}?", { name: (removing as Rule | null)?.name ?? "" })}</DialogTitle>
            <DialogDescription>
              {removing === "mailbox" ? t("Larika stops reading it and deletes its rules and events. The emails stay in the mailbox.") : t("Its events are deleted with it.")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)} disabled={remove.isPending}>
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

/** A rule's form, with a try-it on the last 30 days of real mail before saving. */
function RuleDialog({ box, editing, onClose, onSaved }: { box: MailboxDetail; editing: { id: string | null; rule: RuleInput; secret?: string }; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [rule, setRule] = useState<RuleInput>(editing.rule);
  const [secret, setSecret] = useState(editing.secret);
  const [preview, setPreview] = useState<{ scanned: number; rows: PreviewRow[] } | null>(null);
  const set = (patch: Partial<RuleInput>) => setRule((r) => ({ ...r, ...patch }));

  const tryIt = useMutation({
    mutationFn: () => previewRule(box.id, rule),
    onSuccess: setPreview,
    onError: (e: Error) => toast({ title: t("Failed to try the rule"), description: e.message, variant: "destructive" }),
  });
  const save = useMutation({
    mutationFn: () => (editing.id ? updateRule(editing.id, rule) : createRule(box.id, rule)),
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
                    <p className="text-xs text-muted-foreground">{t("Signing secret — x-larika-signature is sha256= and the HMAC-SHA256 (hex) of the body:")}</p>
                    <CopyField value={secret} />
                    <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => rotate.mutate()} disabled={rotate.isPending}>
                      {t("New secret")}
                    </Button>
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <Label>{t("WhatsApp (optional)")}</Label>
                {box.waNumbers.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("Add a number under Whatsapp Gateway API to be notified on WhatsApp.")}</p>
                ) : (
                  <>
                    <Select value={rule.waNumberId ?? NONE} onValueChange={(v) => set({ waNumberId: v === NONE ? null : v })}>
                      <SelectTrigger aria-label={t("Send from")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>{t("No WhatsApp")}</SelectItem>
                        {box.waNumbers.map((n) => (
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
          <Button type="submit" form="email-rule" disabled={save.isPending}>
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

/** What the rules matched, newest first, with a send-again for failures. */
function EventsTab({ mailboxId, retentionDays }: { mailboxId: string; retentionDays: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = useTableQuery(25);
  const key = ["email-watcher", "events", mailboxId, query.params];
  const { data, isFetching } = useQuery({ queryKey: key, queryFn: () => getEvents(mailboxId, query.params), refetchInterval: 15_000, placeholderData: keepPreviousData });
  const replay = useMutation({
    mutationFn: replayEvent,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["email-watcher", "events", mailboxId] }),
    onError: (e: Error) => toast({ title: t("Failed to send the event again"), description: e.message, variant: "destructive" }),
  });

  const columns: Column<MailEvent>[] = [
    { header: t("Received"), cell: (e) => <span className="whitespace-nowrap">{when(e.receivedAt)}</span> },
    { header: t("Rule"), cell: (e) => e.rule.name },
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
      <p className="text-sm text-muted-foreground">{t("Emails your rules matched, kept {days} days. Failed sends are retried for about 9 hours.", { days: retentionDays })}</p>
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
