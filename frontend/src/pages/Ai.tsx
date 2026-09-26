import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Boxes, KeyRound, List, Loader2, Plus, Sparkles, Trash2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { CopyField } from "@/components/CopyField";
import { useToast } from "@/hooks/use-toast";
import { createAiKey, enableAi, fromMicro, getAi, getAiModels, getWalletEntries, revokeAiKey, rupiah, type AiKey, type AiModelPrice, type WalletEntry } from "@/lib/ai";
import { locale, t } from "@/lib/i18n";

const KEY = ["ai"];

const when = (at: string | null) => (at ? new Date(at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : "—");

/**
 * A workspace's AI API: one OpenAI-compatible endpoint for many models, charged
 * to the workspace's rupiah balance per token. Owners and admins only.
 */
export default function Ai() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: KEY, queryFn: getAi, refetchInterval: 60_000 });
  const [creating, setCreating] = useState<{ name: string; rpm: string } | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<AiKey | null>(null);
  const keysQuery = useTableQuery(10);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: KEY });
  const failed = (title: string) => (e: Error) => toast({ title, description: e.message, variant: "destructive" });
  const enable = useMutation({ mutationFn: enableAi, onSuccess: refresh, onError: failed(t("Failed to turn the AI API on")) });
  const create = useMutation({
    mutationFn: createAiKey,
    onSuccess: (k) => {
      setCreating(null);
      setNewKey(k.key);
      refresh();
    },
    onError: failed(t("Failed to create an API key")),
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
    { header: t("Last used"), cell: (k) => when(k.lastUsedAt) },
    {
      header: "",
      className: "w-16 text-right",
      cell: (k) => (
        <Button variant="ghost" size="sm" onClick={() => setRevoking(k)} aria-label={t("Revoke")}>
          <Trash2 className="h-4 w-4" />
        </Button>
      ),
    },
  ];

  const balance = data ? fromMicro(data.balance) : 0;

  return (
    <PageLayout
      icon={Sparkles}
      title={t("AI API")}
      description={t("One OpenAI-compatible API for many models, paid per token from the workspace balance.")}
      actions={
        data?.hasAccount && (
          <Button onClick={() => setCreating({ name: "", rpm: "60" })}>
            <Plus className="mr-2 h-4 w-4" /> {t("New key")}
          </Button>
        )
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
        <p className="text-sm text-muted-foreground">{t("The AI API is not available on this platform yet.")}</p>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-[1fr_2fr]">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Wallet className="h-4 w-4 text-primary" />
                  {t("Balance")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className={`text-3xl font-semibold tabular-nums ${balance <= 0 ? "text-destructive" : ""}`}>{rupiah(balance, balance < 100)}</p>
                <p className="text-xs text-muted-foreground">
                  {balance <= 0 ? t("Calls are refused until the balance is topped up.") : t("Each call is charged from it, every minute.")}{" "}
                  {t("To top up, contact support.")}
                </p>
                {data.suspended && <p className="text-sm text-destructive">{t("The AI API of this workspace is suspended.")}</p>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{t("Endpoint")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {data.baseUrl && <CopyField value={data.baseUrl} />}
                <p className="text-xs text-muted-foreground">
                  {t("Use it as the base URL of any OpenAI SDK, with a key from here as the API key.")}
                </p>
                <pre className="overflow-x-auto rounded-md bg-muted/60 p-3 font-mono text-[11px] leading-relaxed">
                  {`curl ${data.baseUrl}/chat/completions \\
  -H "Authorization: Bearer lk_…" -H "content-type: application/json" \\
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"Halo!"}]}'`}
                </pre>
              </CardContent>
            </Card>
          </div>

          {data.gatewayError && <p className="text-sm text-destructive">{t("The AI gateway did not answer: {error}", { error: data.gatewayError })}</p>}

          {!data.hasAccount ? (
            <Card>
              <CardContent className="flex flex-col items-start gap-3 pt-6">
                <p className="text-sm text-muted-foreground">{t("Turn it on to create API keys. Nothing is charged until a key is used.")}</p>
                <Button onClick={() => enable.mutate()} disabled={enable.isPending}>
                  {enable.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t("Turn on the AI API")}
                </Button>
              </CardContent>
            </Card>
          ) : (
            <Tabs defaultValue="keys" className="space-y-4">
              <TabsList>
                <TabsTrigger value="keys">
                  <KeyRound className="mr-2 h-4 w-4" />
                  {t("Keys")}
                  {data.keys.length > 0 && ` (${data.keys.length})`}
                </TabsTrigger>
                <TabsTrigger value="usage">
                  <List className="mr-2 h-4 w-4" />
                  {t("Usage")}
                </TabsTrigger>
                <TabsTrigger value="models">
                  <Boxes className="mr-2 h-4 w-4" />
                  {t("Models")}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="keys">
                <DataTable
                  columns={keyColumns}
                  rows={data.keys}
                  rowKey={(k) => k.id}
                  query={keysQuery}
                  filter={(k, search) => k.name.toLowerCase().includes(search.toLowerCase())}
                  searchPlaceholder={t("Search keys…")}
                  empty={t("No keys yet. Create one for each app that calls the API.")}
                />
              </TabsContent>
              <TabsContent value="usage">
                <UsageTab />
              </TabsContent>
              <TabsContent value="models">
                <ModelsTable />
              </TabsContent>
            </Tabs>
          )}
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
                create.mutate({ name: creating.name, rpm: Number(creating.rpm) || undefined });
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

const KIND: Record<string, string> = { TOPUP: "Top-up", ADJUST: "Adjustment", AI_USAGE: "AI usage" };

/** The balance's entries this month: AI use by day and model, top-ups, adjustments. */
function UsageTab() {
  const query = useTableQuery(25);
  const { data, isFetching } = useQuery({ queryKey: [...KEY, "entries"], queryFn: () => getWalletEntries(), refetchInterval: 60_000 });
  const rows = data?.entries ?? [];
  const spent = rows.filter((e) => e.kind === "AI_USAGE").reduce((n, e) => n - fromMicro(e.amount), 0);
  const columns: Column<WalletEntry>[] = [
    { header: t("Updated"), cell: (e) => when(e.updatedAt) },
    { header: t("Type"), cell: (e) => t(KIND[e.kind] ?? e.kind) },
    { header: t("Description"), cell: (e) => <span className="text-muted-foreground">{e.note ?? "—"}</span> },
    {
      header: t("Amount"),
      className: "text-right",
      cell: (e) => {
        const v = fromMicro(e.amount);
        return <span className={`tabular-nums ${v < 0 ? "" : "text-success"}`}>{rupiah(v, Math.abs(v) < 100)}</span>;
      },
    },
  ];
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        {t("This month's AI use: {amount}. One line per day and model, added to as calls are billed.", { amount: rupiah(spent, spent < 100) })}
      </p>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(e) => e.id}
        query={query}
        filter={(e, search) => `${e.note ?? ""} ${e.kind}`.toLowerCase().includes(search.toLowerCase())}
        isLoading={isFetching && !rows.length}
        empty={t("Nothing this month yet.")}
      />
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
