import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, BarChart3, BookOpen, Boxes, Code2, Gauge, KeyRound, List, Loader2, Plus, Power, Sparkles, Trash2, Wallet, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { CopyField } from "@/components/CopyField";
import { CodeExample } from "@/components/CodeExample";
import { Step } from "@/components/QuickStartStep";
import { AiPlayground } from "@/components/AiApi";
import { aiCodeExamples, useAiApiCatalog, withVars } from "@/lib/aiApiCatalog";
import { useToast } from "@/hooks/use-toast";
import { createAiKey, enableAi, fromMicro, getAi, getAiModels, revokeAiKey, rupiah, setAiKeyLimit, type AiKey, type AiModelPrice, type AiOverview, type KeyPeriod } from "@/lib/ai";
import { getWalletEntries } from "@/lib/billing";
import { WalletStatement } from "@/pages/Billing";
import { locale, t } from "@/lib/i18n";

const KEY = ["ai"];

const when = (at: string | null) => (at ? new Date(at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : "—");

/**
 * A workspace's AI: one OpenAI-compatible endpoint for many models, charged
 * to the workspace's rupiah balance per token. Owners and admins only.
 */
export default function Ai() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: KEY, queryFn: getAi, refetchInterval: 60_000 });
  const [creating, setCreating] = useState<{ name: string; rpm: string; limit: string; period: KeyPeriod } | null>(null);
  const [limiting, setLimiting] = useState<{ key: AiKey; limit: string; period: KeyPeriod } | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<AiKey | null>(null);
  const keysQuery = useTableQuery(10);
  const [tab, setTab] = useState<string | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: KEY });
  const failed = (title: string) => (e: Error) => toast({ title, description: e.message, variant: "destructive" });
  const enable = useMutation({ mutationFn: enableAi, onSuccess: refresh, onError: failed(t("Failed to turn AI on")) });
  const create = useMutation({
    mutationFn: createAiKey,
    onSuccess: (k) => {
      setCreating(null);
      setNewKey(k.key);
      refresh();
    },
    onError: failed(t("Failed to create an API key")),
  });
  const limit = useMutation({
    mutationFn: ({ id, limit, period }: { id: string; limit: number | null; period: KeyPeriod }) => setAiKeyLimit(id, limit, period),
    onSuccess: () => {
      setLimiting(null);
      refresh();
    },
    onError: failed(t("Failed to change the limit")),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeAiKey(id),
    onSuccess: () => {
      setRevoking(null);
      refresh();
    },
    onError: failed(t("Failed to revoke the key")),
  });

  const keyColumns: Column<AiKey>[] = [
    { header: t("Name"), cell: (k) => <span className="font-medium">{k.name}</span> },
    { header: t("Key"), cell: (k) => <code className="font-mono text-xs">{k.prefix}…</code> },
    { header: t("Requests / min"), cell: (k) => <span className="tabular-nums">{k.rpm}</span> },
    {
      header: t("Spent / limit"),
      // this day or month — the limit's period
      cell: (k) => {
        const spent = fromMicro(k.spent);
        const cap = k.spendCap === null ? null : fromMicro(k.spendCap);
        return (
          <span className={`tabular-nums ${cap !== null && spent >= cap ? "text-destructive" : ""}`}>
            {rupiah(spent, spent < 100)} / {cap === null ? t("no limit") : `${rupiah(cap)} ${per(k.capPeriod)}`}
          </span>
        );
      },
    },
    { header: t("Last used"), cell: (k) => when(k.lastUsedAt) },
    {
      header: "",
      className: "w-24 text-right",
      cell: (k) => (
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLimiting({ key: k, limit: k.spendCap === null ? "" : String(Math.round(fromMicro(k.spendCap))), period: k.capPeriod })}
            aria-label={t("Spending limit")}
            title={t("Spending limit")}
          >
            <Gauge className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setRevoking(k)} aria-label={t("Revoke")}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </>
      ),
    },
  ];

  const startCreating = () => setCreating({ name: "", rpm: "60", limit: "", period: "MONTH" });

  return (
    <PageLayout
      icon={Sparkles}
      title={t("AI")}
      description={t("One OpenAI-compatible API for many models, paid per token from the workspace balance.")}
      actions={
        data?.configured &&
        (data.hasAccount ? (
          <Button onClick={startCreating}>
            <Plus className="mr-2 h-4 w-4" /> {t("New key")}
          </Button>
        ) : (
          <TurnOnButton enable={enable} />
        ))
      }
    >
      {isLoading ? (
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      ) : error || !data ? (
        <p className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {(error as Error)?.message}
        </p>
      ) : !data.configured ? (
        <p className="text-sm text-muted-foreground">{t("The AI is not available on this platform yet.")}</p>
      ) : (
        <>
          {data.gatewayError && <p className="text-sm text-destructive">{t("The AI gateway did not answer: {error}", { error: data.gatewayError })}</p>}
          {data.suspended && <p className="text-sm text-destructive">{t("The AI of this workspace is suspended.")}</p>}
          {/* a workspace with no keys yet lands on the guide */}
          <Tabs value={tab ?? (data.keys.length ? "keys" : "start")} onValueChange={setTab} className="space-y-4">
            <TabsList>
              <TabsTrigger value="start">
                <BookOpen className="mr-2 h-4 w-4" />
                {t("Quick start")}
              </TabsTrigger>
              <TabsTrigger value="keys">
                <KeyRound className="mr-2 h-4 w-4" />
                {t("Keys")}
                {data.keys.length > 0 && ` (${data.keys.length})`}
              </TabsTrigger>
              <TabsTrigger value="api">
                <Code2 className="mr-2 h-4 w-4" />
                API
              </TabsTrigger>
              <TabsTrigger value="by-model">
                <BarChart3 className="mr-2 h-4 w-4" />
                {t("Usage")}
              </TabsTrigger>
              <TabsTrigger value="usage">
                <List className="mr-2 h-4 w-4" />
                {t("Log")}
              </TabsTrigger>
              <TabsTrigger value="models">
                <Boxes className="mr-2 h-4 w-4" />
                {t("Models")}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="start">
              <QuickStart data={data} enable={enable} onCreate={startCreating} onModels={() => setTab("models")} onApi={() => setTab("api")} />
            </TabsContent>
            <TabsContent value="keys">
              {data.hasAccount ? (
                <DataTable
                  columns={keyColumns}
                  rows={data.keys}
                  rowKey={(k) => k.id}
                  query={keysQuery}
                  filter={(k, search) => k.name.toLowerCase().includes(search.toLowerCase())}
                  searchPlaceholder={t("Search keys…")}
                  empty={t("No keys yet. Create one for each app that calls the API.")}
                />
              ) : (
                <TurnOn enable={enable} />
              )}
            </TabsContent>
            <TabsContent value="api">
              <AiPlayground baseUrl={data.baseUrl ?? ""} onCreateKey={data.hasAccount ? startCreating : undefined} />
            </TabsContent>
            <TabsContent value="by-model">
              <UsageByModel />
            </TabsContent>
            <TabsContent value="usage">
              <UsageTab />
            </TabsContent>
            <TabsContent value="models">
              <ModelsTable />
            </TabsContent>
          </Tabs>
        </>
      )}

      <Dialog open={!!creating} onOpenChange={(o) => !o && setCreating(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("New key")}</DialogTitle>
            <DialogDescription>{t("One key per app, so one can be revoked without stopping the others.")}</DialogDescription>
          </DialogHeader>
          {creating && (
            <form
              id="ai-key"
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate({ name: creating.name, rpm: Number(creating.rpm) || undefined, limit: Number(creating.limit) || undefined, period: creating.period });
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="ai-key-name">{t("Name")}</Label>
                <Input id="ai-key-name" required autoFocus maxLength={80} value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ai-key-rpm">{t("Requests per minute")}</Label>
                <Input id="ai-key-rpm" type="number" min={1} max={600} value={creating.rpm} onChange={(e) => setCreating({ ...creating, rpm: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ai-key-limit">{t("Spending limit (Rp, optional)")}</Label>
                <div className="flex gap-2">
                  <Input id="ai-key-limit" type="number" min={1000} step={1000} placeholder={t("No limit")} value={creating.limit} onChange={(e) => setCreating({ ...creating, limit: e.target.value })} />
                  <PeriodSelect value={creating.period} onChange={(period) => setCreating({ ...creating, period })} />
                </div>
                <p className="text-xs text-muted-foreground">{t("The key is refused once it has spent this much in a day or month (WIB), so a leaked key or a runaway loop cannot drain the balance.")}</p>
              </div>
            </form>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(null)} disabled={create.isPending}>
              {t("Cancel")}
            </Button>
            <Button type="submit" form="ai-key" disabled={create.isPending}>
              {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("Create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!newKey} onOpenChange={(o) => !o && setNewKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("API key")}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-2">
            {newKey && <CopyField value={newKey} />}
            <p className="text-xs text-warning">{t("Copy it now — it is not shown again.")}</p>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setNewKey(null)}>{t("Done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!limiting} onOpenChange={(o) => !o && setLimiting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Spending limit for {name}", { name: limiting?.key.name ?? "" })}</DialogTitle>
            <DialogDescription>
              {t("Spent this period: {amount}. The key is refused once it reaches the limit, until the next day or month (WIB); empty means no limit.", {
                amount: limiting ? rupiah(fromMicro(limiting.key.spent), fromMicro(limiting.key.spent) < 100) : "",
              })}
            </DialogDescription>
          </DialogHeader>
          {limiting && (
            <form
              id="ai-key-limit-form"
              onSubmit={(e) => {
                e.preventDefault();
                limit.mutate({ id: limiting.key.id, limit: Number(limiting.limit) || null, period: limiting.period });
              }}
            >
              <Label htmlFor="ai-key-limit-edit">{t("Limit (Rp)")}</Label>
              <div className="flex gap-2">
                <Input id="ai-key-limit-edit" type="number" min={1000} step={1000} autoFocus placeholder={t("No limit")} value={limiting.limit} onChange={(e) => setLimiting({ ...limiting, limit: e.target.value })} />
                <PeriodSelect value={limiting.period} onChange={(period) => setLimiting({ ...limiting, period })} />
              </div>
            </form>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setLimiting(null)} disabled={limit.isPending}>
              {t("Cancel")}
            </Button>
            <Button type="submit" form="ai-key-limit-form" disabled={limit.isPending}>
              {limit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!revoking} onOpenChange={(o) => !o && setRevoking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Revoke {name}?", { name: revoking?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("Apps using this key stop working at once.")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevoking(null)} disabled={revoke.isPending}>
              {t("Cancel")}
            </Button>
            <Button variant="destructive" disabled={revoke.isPending} onClick={() => revoking && revoke.mutate(revoking.id)}>
              {revoke.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("Revoke")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageLayout>
  );
}

type ModelUsage = { model: string; cost: number; days: number };

/**
 * A month's AI use by model: what each cost, on how many days, and its share.
 * Summed from the wallet's AI lines (one per day and model) — the Log tab's
 * rows, added up.
 * ponytail: cost only — tokens and request counts are not kept here, the gateway meters them; a per-model feed from it if they are wanted
 */
function UsageByModel() {
  const query = useTableQuery(25);
  const [month, setMonth] = useState("");
  const { data, isFetching } = useQuery({ queryKey: ["billing", "entries", month], queryFn: () => getWalletEntries(month || undefined), refetchInterval: 60_000 });
  const byModel = new Map<string, ModelUsage>();
  for (const e of data?.entries ?? []) {
    if (e.kind !== "AI_USAGE") continue;
    // the line's note: "AI · <model> · <day>"
    const model = /^AI · (.+) · \d{4}-\d{2}-\d{2}$/.exec(e.note ?? "")?.[1] ?? t("Other");
    const row = byModel.get(model) ?? { model, cost: 0, days: 0 };
    row.cost -= fromMicro(e.amount);
    row.days += 1;
    byModel.set(model, row);
  }
  const rows = [...byModel.values()].sort((a, b) => b.cost - a.cost);
  const total = rows.reduce((n, r) => n + r.cost, 0);

  const columns: Column<ModelUsage>[] = [
    { header: t("Model"), cell: (r) => <span className="font-mono text-xs">{r.model}</span> },
    { header: t("Days used"), className: "w-28 text-right", cell: (r) => <span className="tabular-nums">{r.days}</span> },
    { header: t("Cost"), className: "w-36 text-right", cell: (r) => <span className="tabular-nums">{rupiah(r.cost, r.cost < 100)}</span> },
    {
      header: t("Share"),
      className: "w-56",
      cell: (r) => {
        const pct = total > 0 ? (r.cost / total) * 100 : 0;
        return (
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
            </div>
            <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{pct.toFixed(pct < 10 ? 1 : 0)}%</span>
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        {t("AI use by model in {month}: {amount} across {count} model(s).", { month: data?.month ?? "…", amount: rupiah(total, total < 100), count: rows.length })}
      </p>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.model}
        query={query}
        filter={(r, search) => r.model.toLowerCase().includes(search.toLowerCase())}
        isLoading={isFetching && !data}
        searchPlaceholder={t("Search models…")}
        empty={t("No AI use in this month.")}
        toolbar={<Input type="month" className="w-44" value={month || data?.month || ""} onChange={(e) => setMonth(e.target.value)} />}
      />
    </div>
  );
}

/** This month's AI use: one line per day and model, added to as calls are billed. */
function UsageTab() {
  const { data } = useQuery({ queryKey: ["billing", "entries", ""], queryFn: () => getWalletEntries(), refetchInterval: 60_000 });
  const spent = (data?.entries ?? []).filter((e) => e.kind === "AI_USAGE").reduce((n, e) => n - fromMicro(e.amount), 0);
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        {t("This month's AI use: {amount}. One line per day and model, added to as calls are billed.", { amount: rupiah(spent, spent < 100) })}
      </p>
      <WalletStatement only="AI_USAGE" />
    </div>
  );
}

/** What each model costs here, per 1M tokens. Shared with the Pricing page. */
export function ModelsTable() {
  const query = useTableQuery(25);
  const { data = [], isFetching } = useQuery({ queryKey: ["ai-models"], queryFn: getAiModels, staleTime: 10 * 60_000 });
  const price = (m: AiModelPrice, k: "input" | "cacheRead" | "output") =>
    m.tiers.map((tier) => rupiah(tier[k])).join(" / ");
  const columns: Column<AiModelPrice>[] = [
    {
      header: t("Model"),
      cell: (m) => (
        <div>
          <code className="font-mono text-xs">{m.id}</code>
          {m.peak && <p className="text-xs text-muted-foreground">{t("Off-peak price; more in the provider's peak hours")}</p>}
          {m.tiers.length > 1 && (
            <p className="text-xs text-muted-foreground">
              {t("By prompt size: up to {sizes} tokens", { sizes: m.tiers.map((tier) => (tier.upTo ? tier.upTo.toLocaleString(locale) : "∞")).join(" / ") })}
            </p>
          )}
        </div>
      ),
    },
    { header: t("Context"), cell: (m) => <span className="tabular-nums">{m.contextWindow.toLocaleString(locale)}</span> },
    { header: t("Input"), className: "text-right", cell: (m) => <span className="tabular-nums">{price(m, "input")}</span> },
    { header: t("Cached input"), className: "text-right", cell: (m) => <span className="tabular-nums">{price(m, "cacheRead")}</span> },
    { header: t("Output"), className: "text-right", cell: (m) => <span className="tabular-nums">{price(m, "output")}</span> },
  ];
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{t("Rupiah per 1 million tokens. Send the model name as `model`.")}</p>
      <DataTable
        columns={columns}
        rows={data}
        rowKey={(m) => m.id}
        query={query}
        filter={(m, search) => m.id.toLowerCase().includes(search.toLowerCase())}
        isLoading={isFetching && !data.length}
        searchPlaceholder={t("Search models…")}
        empty={t("No models yet.")}
      />
    </div>
  );
}

const per = (period: KeyPeriod) => (period === "DAY" ? t("/ day") : t("/ month"));

/** A key limit's period: per WIB day or month. */
function PeriodSelect({ value, onChange }: { value: KeyPeriod; onChange: (period: KeyPeriod) => void }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as KeyPeriod)}>
      <SelectTrigger className="w-36" aria-label={t("Per")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="DAY">{t("per day")}</SelectItem>
        <SelectItem value="MONTH">{t("per month")}</SelectItem>
      </SelectContent>
    </Select>
  );
}

type Enable = { mutate: () => void; isPending: boolean };

function TurnOnButton({ enable, size }: { enable: Enable; size?: "sm" }) {
  return (
    <Button size={size} onClick={() => enable.mutate()} disabled={enable.isPending}>
      {enable.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Power className="mr-2 h-4 w-4" />}
      {t("Turn on AI")}
    </Button>
  );
}

function TurnOn({ enable }: { enable: Enable }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border p-6">
      <p className="text-sm text-muted-foreground">{t("Turn it on to create API keys. Nothing is charged until a key is used.")}</p>
      <TurnOnButton enable={enable} size="sm" />
    </div>
  );
}

/**
 * From nothing to a first answer, each step ticked off from the workspace's own
 * state. Examples use the first model on the list, so they paste as is.
 */
function QuickStart({ data, enable, onCreate, onModels, onApi }: { data: AiOverview; enable: Enable; onCreate: () => void; onModels: () => void; onApi: () => void }) {
  const { data: catalog } = useAiApiCatalog();
  const chat = catalog?.endpoints.find((e) => e.id === "chat");
  const baseUrl = data.baseUrl ?? "";
  const origin = baseUrl.replace(/\/v1\/?$/, "");
  const balance = fromMicro(data.balance);
  const hasKey = data.keys.length > 0;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-primary">
          <Zap className="h-4 w-4" />
          {t("Base URL")}
        </div>
        {baseUrl && <CopyField value={baseUrl} />}
        <p className="text-xs text-muted-foreground">
          {t("Use it as the base URL of any OpenAI SDK, with a key from here as the API key.")}{" "}
          <button type="button" onClick={onApi} className="text-primary underline-offset-2 hover:underline">
            {t("Full API reference")}
          </button>
        </p>
      </div>

      <Step n={1} done={data.hasAccount && balance > 0} title={t("Turn on AI and have a balance")}>
        <p className="text-sm text-muted-foreground">
          {t("Balance")}: <span className={`font-medium tabular-nums ${balance <= 0 ? "text-destructive" : "text-foreground"}`}>{rupiah(balance, balance < 100)}</span>.{" "}
          {balance <= 0 ? t("Calls are refused until the balance is topped up.") : t("Calls are paid per token from the balance, charged every minute.")}
        </p>
        {data.payer && <p className="text-xs text-muted-foreground">{t("Paid from {name}'s balance, shared by the workspaces they pay for.", { name: data.payer.name || data.payer.email })}</p>}
        <div className="flex flex-wrap gap-2">
          {!data.hasAccount && <TurnOnButton enable={enable} size="sm" />}
          <Button variant="outline" size="sm" asChild>
            <a href="/usage">
              <Wallet className="mr-2 h-4 w-4" />
              {t("Top up on the Usage page.")}
            </a>
          </Button>
        </div>
      </Step>

      <Step n={2} done={hasKey} title={t("Create an API key")}>
        <p className="text-sm text-muted-foreground">{t("One key per app, so one can be revoked without stopping the others. A spending limit per day or month keeps a leaked key or a runaway loop from draining the balance. The key is shown once.")}</p>
        {data.hasAccount && (
          <Button size="sm" onClick={onCreate}>
            <Plus className="mr-2 h-4 w-4" />
            {t("New key")}
          </Button>
        )}
      </Step>

      <Step n={3} title={t("Make your first call")}>
        <p className="text-sm text-muted-foreground">{t("It is the OpenAI API: any OpenAI SDK works with the base URL above and a key from here.")}</p>
        {chat ? <CodeExample examples={aiCodeExamples(origin, chat, withVars(JSON.stringify(chat.body, null, 2), catalog!.vars))} /> : <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        <Button variant="outline" size="sm" onClick={onApi}>
          <Code2 className="mr-2 h-4 w-4" />
          {t("Try it in the playground")}
        </Button>
      </Step>

      <Step n={4} title={t("Pick a model")}>
        <p className="text-sm text-muted-foreground">{t("Send any model from the list as `model`.")}</p>
        <Button variant="outline" size="sm" onClick={onModels}>
          <Boxes className="mr-2 h-4 w-4" />
          {t("Models")}
        </Button>
      </Step>
    </div>
  );
}
