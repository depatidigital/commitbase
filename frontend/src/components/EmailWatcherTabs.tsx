import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { useToast } from "@/hooks/use-toast";
import {
  createRule,
  deleteRule,
  EVENTS_KEY,
  getEvents,
  getRules,
  MAILBOXES_KEY,
  replayEvent,
  RULES_KEY,
  updateRule,
  when,
  type EventStatus,
  type Mailbox,
  type MailEvent,
  type Rule,
  type RuleInput,
} from "@/lib/emailWatcher";
import { t } from "@/lib/i18n";

const BLANK = "blank";

/** Rules to start from — only formats seen in real notification emails. */
const PRESETS: Array<{ label: string; rule: Partial<RuleInput> }> = [
  {
    label: "BNI Merchant",
    rule: {
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

const dataLine = (data: Record<string, unknown>) =>
  Object.entries(data)
    .map(([k, v]) => `${k}: ${v ?? "—"}`)
    .join(" · ");

/** Every rule of the mailboxes the caller manages. A new one gets a name and mailbox here, then opens in its editor. */
export function RulesTab({ mailboxes }: { mailboxes: Mailbox[] }) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useTableQuery(10);
  const { data, isFetching } = useQuery({ queryKey: RULES_KEY, queryFn: getRules, refetchInterval: 30_000 });
  const rules = data?.rules ?? [];
  const managed = mailboxes.filter((m) => m.canManage);
  const [creating, setCreating] = useState<{ name: string; mailboxId: string; preset: string } | null>(null);
  const [removing, setRemoving] = useState<Rule | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: RULES_KEY });
    // a rule turned on or off starts or stops its mailbox
    void queryClient.invalidateQueries({ queryKey: MAILBOXES_KEY });
  };
  const open = (id: string) => navigate(`/email-watcher/rules/${id}`);
  const create = useMutation({
    mutationFn: (c: { name: string; mailboxId: string; preset: string }) =>
      createRule(c.mailboxId, { ...(PRESETS.find((p) => p.label === c.preset)?.rule ?? {}), name: c.name }),
    onSuccess: (rule) => {
      refresh();
      open(rule.id);
    },
    onError: (e: Error) => toast({ title: t("Failed to save the rule"), description: e.message, variant: "destructive" }),
  });
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
          {[r.fromContains && t("from “{v}”", { v: r.fromContains }), r.subjectContains && t("subject “{v}”", { v: r.subjectContains }), r.bodyContains && t("body “{v}”", { v: r.bodyContains })]
            .filter(Boolean)
            .join(", ") || t("no filter yet")}
        </span>
      ),
    },
    { header: t("Reads"), cell: (r) => <span className="font-mono text-xs">{r.fields.map((f) => f.name).join(", ") || "—"}</span> },
    { header: t("Sends to"), cell: (r) => <span className="text-xs">{[r.webhookUrl && "Webhook", r.waNumberId && r.waTo && "WhatsApp"].filter(Boolean).join(" + ") || t("nowhere")}</span> },
    {
      header: t("On"),
      cell: (r) => (
        // the row opens the editor; the switch only switches
        <span onClick={(e) => e.stopPropagation()}>
          <Switch checked={r.active} onCheckedChange={() => toggle.mutate(r)} aria-label={t("Rule on")} />
        </span>
      ),
    },
    {
      header: "",
      className: "w-24 text-right",
      cell: (r) => (
        <>
          <Button variant="ghost" size="sm" aria-label={t("Edit")} onClick={() => open(r.id)}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("Delete")}
            onClick={(e) => {
              e.stopPropagation();
              setRemoving(r);
            }}
          >
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
        onRowClick={(r) => open(r.id)}
        searchPlaceholder={t("Search rules…")}
        toolbar={
          <Button disabled={!managed[0]} onClick={() => managed[0] && setCreating({ name: "", mailboxId: managed[0].id, preset: BLANK })}>
            <Plus className="mr-2 h-4 w-4" /> {t("New rule")}
          </Button>
        }
        empty={managed.length ? t("No rules yet. A rule picks emails by sender and subject and reads values out of them.") : t("Add a mailbox first; its rules show here.")}
      />

      <Dialog open={!!creating} onOpenChange={(o) => !o && setCreating(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("New rule")}</DialogTitle>
            <DialogDescription>{t("Name it and pick its mailbox; the editor opens next, with the mailbox's emails to try it on.")}</DialogDescription>
          </DialogHeader>
          {creating && (
            <form
              id="new-rule"
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate(creating);
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="new-rule-name">{t("Name")}</Label>
                <Input id="new-rule-name" required autoFocus maxLength={80} placeholder="BNI Merchant" value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} />
              </div>
              {managed.length > 1 && (
                <div className="space-y-1">
                  <Label>{t("Mailbox")}</Label>
                  <Select value={creating.mailboxId} onValueChange={(mailboxId) => setCreating({ ...creating, mailboxId })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {managed.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-1">
                <Label>{t("Start from")}</Label>
                <Select value={creating.preset} onValueChange={(preset) => setCreating({ ...creating, preset, name: creating.name || (preset === BLANK ? "" : preset) })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={BLANK}>{t("Blank")}</SelectItem>
                    {PRESETS.map((p) => (
                      <SelectItem key={p.label} value={p.label}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </form>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(null)} disabled={create.isPending}>
              {t("Cancel")}
            </Button>
            <Button type="submit" form="new-rule" disabled={create.isPending}>
              {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("Create and edit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
