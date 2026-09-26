import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { CheckCircle2, KeyRound, Loader2, MessageCircle, Plus, QrCode, RefreshCw, RotateCcw, Send, Settings2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { CopyField } from "@/components/CopyField";
import { getActiveOrg } from "@/lib/api";
import { isAdmin } from "@/lib/auth";
import { getOrganizations } from "@/lib/organizations";
import {
  createWaKey,
  createWaNumber,
  deleteWaNumber,
  getWaKeys,
  getWaNumber,
  getWaNumbers,
  getWebhookSecret,
  relinkWaNumber,
  restartWaNumber,
  revokeWaKey,
  rotateWebhookSecret,
  sendTestMessage,
  updateWaNumber,
  type NumberStatus,
  type WaNumber,
} from "@/lib/waGateway";
import { locale, t } from "@/lib/i18n";

const LIST_KEY = ["wa-numbers"];

const STATUS: Record<NumberStatus, { label: () => string; dot: string }> = {
  ONLINE: { label: () => t("Online"), dot: "bg-success" },
  QR: { label: () => t("Waiting for QR scan"), dot: "bg-warning" },
  CONNECTING: { label: () => t("Connecting"), dot: "bg-warning" },
  OFFLINE: { label: () => t("Offline"), dot: "bg-destructive" },
  MISSING: { label: () => t("Not on the gateway"), dot: "bg-destructive" },
};

function StatusDot({ status }: { status: NumberStatus | null }) {
  if (!status) return <span className="text-xs text-muted-foreground">—</span>;
  const s = STATUS[status];
  return (
    <span className="flex items-center gap-2 whitespace-nowrap text-sm">
      <span className={`h-2 w-2 shrink-0 rounded-full ${s.dot}`} />
      {s.label()}
    </span>
  );
}

/** Which dialog is open, for which number. */
type Open = { kind: "connect" | "test" | "api" | "access" | "delete"; row: Pick<WaNumber, "id" | "name"> };

/**
 * A workspace's WhatsApp numbers on the Larika gateway: link one by QR, then an
 * app sends and receives through the gateway's API with the number's key. Each
 * row's buttons open one small dialog: Scan QR, Test, API keys, access, delete.
 */
export default function WaGateway() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = useTableQuery(25);
  const [adding, setAdding] = useState<{ name: string; organizationId: string; ipAllowlist: string; webhookUrl: string } | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  // the key made with a new number, shown once in its API dialog
  const [firstKey, setFirstKey] = useState<{ id: string; apiKey: string } | null>(null);

  const { data, isFetching } = useQuery({ queryKey: LIST_KEY, queryFn: getWaNumbers, refetchInterval: 30_000 });
  const rows = data?.rows ?? [];
  const { data: orgs = [] } = useQuery({ queryKey: ["organizations"], queryFn: getOrganizations, enabled: !!adding });
  // who may add: platform admins, or owners/admins of a workspace
  const manageable = orgs.filter((org) => isAdmin() || org.myRole === "OWNER" || org.myRole === "ADMIN");
  const showWorkspace = isAdmin() || new Set(rows.map((r) => r.organization.id)).size > 1;
  const close = () => {
    setOpen(null);
    void queryClient.invalidateQueries({ queryKey: LIST_KEY });
  };

  const create = useMutation({
    mutationFn: createWaNumber,
    onSuccess: (created, input) => {
      setAdding(null);
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
      if (created.apiKey) setFirstKey({ id: created.id, apiKey: created.apiKey });
      // first step: link the phone
      setOpen({ kind: "connect", row: { id: created.id, name: input.name } });
    },
    onError: (e: Error) => toast({ title: t("Failed to add the number"), description: e.message, variant: "destructive" }),
  });

  const columns: Column<WaNumber>[] = [
    {
      header: t("Number"),
      cell: (row) => (
        <div className="min-w-0">
          <div className="font-medium">{row.name}</div>
          {row.phone && <div className="font-mono text-xs text-muted-foreground">+{row.phone}</div>}
          {showWorkspace && <div className="text-xs text-muted-foreground">{row.organization.name}</div>}
        </div>
      ),
    },
    { header: t("Status"), cell: (row) => <StatusDot status={row.status} /> },
    {
      header: t("Node"),
      cell: (row) =>
        row.nodeName ? (
          <span className={`text-sm ${row.nodeOnline ? "" : "text-muted-foreground"}`} title={row.nodeOnline ? t("Online") : t("Offline")}>
            {row.nodeName}
          </span>
        ) : (
          "—"
        ),
    },
    { header: t("Sent 24 h"), cell: (row) => <span className="tabular-nums">{row.sent24h}</span> },
    {
      header: "Webhook",
      cell: (row) =>
        row.webhookUrl ? (
          <span className="block max-w-[14rem] truncate font-mono text-xs" title={row.webhookUrl}>
            {row.webhookUrl}
          </span>
        ) : (
          "—"
        ),
    },
    {
      header: t("API access from"),
      cell: (row) =>
        row.ipAllowlist.includes("*") ? (
          <span className="text-xs text-destructive">{t("any IP")}</span>
        ) : (
          <span className="block max-w-[12rem] truncate font-mono text-xs" title={row.ipAllowlist.join(", ")}>
            {row.ipAllowlist.join(", ") || "—"}
          </span>
        ),
    },
    {
      header: "",
      className: "text-right",
      cell: (row) =>
        row.canManage && (
          <div className="flex items-center justify-end gap-1.5">
            {row.status && row.status !== "ONLINE" && row.status !== "MISSING" && (
              <Button size="sm" className="h-8" onClick={() => setOpen({ kind: "connect", row })}>
                <QrCode className="mr-1.5 h-3.5 w-3.5" />
                {t("Scan QR")}
              </Button>
            )}
            {row.status === "ONLINE" && (
              <Button variant="outline" size="sm" className="h-8" onClick={() => setOpen({ kind: "test", row })}>
                <Send className="mr-1.5 h-3.5 w-3.5" />
                {t("Test")}
              </Button>
            )}
            <Button variant="outline" size="sm" className="h-8 w-8 p-0" title={t("API & keys")} aria-label={t("API & keys")} onClick={() => setOpen({ kind: "api", row })}>
              <KeyRound className="h-3.5 w-3.5" />
            </Button>
            <Button variant="outline" size="sm" className="h-8 w-8 p-0" title={t("Access & webhook")} aria-label={t("Access & webhook")} onClick={() => setOpen({ kind: "access", row })}>
              <Settings2 className="h-3.5 w-3.5" />
            </Button>
            <Button variant="outline" size="sm" className="h-8 w-8 p-0" title={t("Delete")} aria-label={t("Delete")} onClick={() => setOpen({ kind: "delete", row })}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ),
    },
  ];

  return (
    <PageLayout
      icon={MessageCircle}
      title="Whatsapp Gateway API"
      description={t("Link a WhatsApp number by QR, then send and receive messages from your apps with its API key.")}
      actions={
        <Button onClick={() => setAdding({ name: "", organizationId: getActiveOrg() ?? "", ipAllowlist: "*", webhookUrl: "" })}>
          <Plus className="mr-2 h-4 w-4" /> {t("Add number")}
        </Button>
      }
    >
      {data?.gatewayError && <p className="text-sm text-destructive">{t("The gateway did not answer: {error}", { error: data.gatewayError })}</p>}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        query={query}
        filter={(row, search) => `${row.name} ${row.phone ?? ""} ${row.organization.name}`.toLowerCase().includes(search.toLowerCase())}
        isLoading={isFetching && !rows.length}
        searchPlaceholder={t("Search numbers…")}
        empty={t("No WhatsApp numbers yet.")}
      />

      <Dialog open={!!adding} onOpenChange={(o) => !o && setAdding(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Add number")}</DialogTitle>
            <DialogDescription>{t("After adding, scan the QR code with WhatsApp on the phone (Linked devices → Link a device).")}</DialogDescription>
          </DialogHeader>
          {adding && (
            <form
              id="add-number"
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate({ ...adding, organizationId: adding.organizationId || undefined, webhookUrl: adding.webhookUrl.trim() || undefined });
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="number-name">{t("Name")}</Label>
                <Input id="number-name" autoFocus maxLength={80} placeholder="CS Toko" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
              </div>
              {manageable.length > 1 && (
                <div className="space-y-1">
                  <Label>{t("Workspace")}</Label>
                  <Select value={adding.organizationId} onValueChange={(organizationId) => setAdding({ ...adding, organizationId })}>
                    <SelectTrigger>
                      <SelectValue placeholder={t("Pick a workspace")} />
                    </SelectTrigger>
                    <SelectContent>
                      {manageable.map((org) => (
                        <SelectItem key={org.id} value={org.id}>
                          {org.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <IpAllowlistField value={adding.ipAllowlist} onChange={(ipAllowlist) => setAdding({ ...adding, ipAllowlist })} />
              <WebhookField value={adding.webhookUrl} onChange={(webhookUrl) => setAdding({ ...adding, webhookUrl })} />
            </form>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdding(null)} disabled={create.isPending}>
              {t("Cancel")}
            </Button>
            <Button type="submit" form="add-number" disabled={create.isPending || !adding?.name.trim() || !adding?.ipAllowlist.trim()}>
              {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("Add")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {open?.kind === "connect" && <ConnectDialog id={open.row.id} onClose={close} onDone={() => setOpen({ kind: "api", row: open.row })} />}
      {open?.kind === "test" && <TestDialog row={open.row} onClose={close} />}
      {open?.kind === "api" && (
        <ApiDialog
          id={open.row.id}
          firstKey={firstKey?.id === open.row.id ? firstKey.apiKey : null}
          onClose={() => {
            if (firstKey?.id === open.row.id) setFirstKey(null);
            close();
          }}
        />
      )}
      {open?.kind === "access" && <AccessDialog id={open.row.id} onClose={close} />}
      {open?.kind === "delete" && <DeleteDialog row={open.row} onClose={close} />}
    </PageLayout>
  );
}

function IpAllowlistField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="space-y-1">
      <Label htmlFor="number-ips">{t("Allowed IPs")}</Label>
      <Input id="number-ips" className="font-mono" placeholder="203.0.113.10, 10.0.0.0/8" value={value} onChange={(e) => onChange(e.target.value)} />
      <p className="text-xs text-muted-foreground">{t("The servers allowed to call the API with this number's key, separated by commas. * allows any IP (the key is still required).")}</p>
    </div>
  );
}

function WebhookField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="space-y-1">
      <Label htmlFor="number-webhook">
        Webhook URL <span className="text-muted-foreground">{t("(optional)")}</span>
      </Label>
      <Input id="number-webhook" className="font-mono" placeholder="https://app.example.com/wa/webhook" value={value} onChange={(e) => onChange(e.target.value)} />
      <p className="text-xs text-muted-foreground">{t("Incoming messages, receipts and status changes are POSTed here, signed with the webhook secret.")}</p>
    </div>
  );
}

const useNumber = (id: string, fast = false) =>
  useQuery({
    queryKey: ["wa-number", id],
    queryFn: () => getWaNumber(id),
    // linking: the QR changes every ~20 s and the scan flips it ONLINE — poll fast until then
    refetchInterval: fast ? (q) => (q.state.data?.status === "ONLINE" ? false : 2_000) : false,
    retry: false,
  });

const failedToast = (toast: ReturnType<typeof useToast>["toast"], title: string) => (e: Error) => toast({ title, description: e.message, variant: "destructive" });

/** Link the phone: the QR, and nothing else. */
function ConnectDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: number, error, isLoading } = useNumber(id, true);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["wa-number", id] });
  const relink = useMutation({ mutationFn: () => relinkWaNumber(id), onSuccess: refresh, onError: failedToast(toast, t("Failed to relink the number")) });
  const restart = useMutation({ mutationFn: () => restartWaNumber(id), onSuccess: refresh, onError: failedToast(toast, t("Failed to restart the number")) });
  const linked = number?.status === "ONLINE";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {t("Scan QR")} — {number?.name ?? ""}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 text-center">
          {isLoading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : error ? (
            <p className="text-sm text-destructive">{(error as Error).message}</p>
          ) : linked ? (
            <>
              <CheckCircle2 className="h-12 w-12 text-success" />
              <p className="text-sm">
                {t("Linked")}
                {number.phone && <span className="font-mono"> · +{number.phone}</span>}
              </p>
            </>
          ) : number?.status === "QR" && number.qr ? (
            <>
              <div className="rounded-md bg-white p-3">
                <QRCodeSVG value={number.qr} size={240} />
              </div>
              <p className="text-xs text-muted-foreground">{t("On the phone: WhatsApp → Linked devices → Link a device, then scan this code.")}</p>
            </>
          ) : (
            <>
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <p className="text-xs text-muted-foreground">{t("Preparing the QR code on the WA node…")}</p>
            </>
          )}
          {number?.error && !linked && <p className="text-xs text-destructive">{number.error}</p>}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {linked ? (
            <>
              <Button variant="outline" onClick={onClose}>
                {t("Close")}
              </Button>
              <Button onClick={onDone}>
                <KeyRound className="mr-2 h-4 w-4" />
                {t("API & keys")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" disabled={restart.isPending} onClick={() => restart.mutate()}>
                <RefreshCw className={`mr-2 h-3.5 w-3.5 ${restart.isPending ? "animate-spin" : ""}`} />
                {t("Restart")}
              </Button>
              <Button variant="outline" size="sm" disabled={relink.isPending} onClick={() => relink.mutate()}>
                <RotateCcw className="mr-2 h-3.5 w-3.5" />
                {t("New QR code")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Send one message from the number, the way an app would, and say how it went. */
function TestDialog({ row, onClose }: { row: Pick<WaNumber, "id" | "name">; onClose: () => void }) {
  const [to, setTo] = useState("");
  const [text, setText] = useState(() => t("Test message from Larika"));
  const send = useMutation({ mutationFn: () => sendTestMessage(row.id, { to, text }) });
  const result = send.data;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("Send a test message")} — {row.name}
          </DialogTitle>
          <DialogDescription>{t("Sent through the gateway like an app's message, and counts toward the number's daily limit.")}</DialogDescription>
        </DialogHeader>
        <form
          id="test-message"
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            // Ctrl+Enter submits too: the same rules as the Send button
            if (send.isPending || !to.trim() || !text.trim()) return;
            send.mutate();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="test-to">{t("To")}</Label>
            <Input id="test-to" autoFocus inputMode="tel" className="font-mono" placeholder="08123456789" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="test-text">{t("Message")}</Label>
            <Textarea
              id="test-text"
              rows={3}
              maxLength={4096}
              value={text}
              onChange={(e) => setText(e.target.value)}
              // Ctrl/⌘+Enter sends; Enter alone is a new line
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <p className="text-xs text-muted-foreground">{t("Ctrl+Enter to send")}</p>
          </div>
        </form>
        {send.error ? (
          <p className="text-sm text-destructive">{(send.error as Error).message}</p>
        ) : result ? (
          ["SENT", "DELIVERED", "READ"].includes(result.status) ? (
            <p className="flex items-center gap-2 text-sm text-success">
              <CheckCircle2 className="h-4 w-4" />
              {t("Sent")}
            </p>
          ) : (
            // still queued after 30 s: pacing or the node is busy — it goes out on its own
            <p className="text-sm text-muted-foreground">{t("Queued ({status}) — it is sent as soon as the number's turn comes.", { status: result.status })}</p>
          )
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={send.isPending}>
            {t("Close")}
          </Button>
          <Button type="submit" form="test-message" disabled={send.isPending || !to.trim() || !text.trim()}>
            {send.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            {t("Send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** How an app calls it: base URL, an example, and the keys. */
function ApiDialog({ id, firstKey, onClose }: { id: string; firstKey: string | null; onClose: () => void }) {
  const { toast } = useToast();
  const [shownKey, setShownKey] = useState<string | null>(firstKey);
  const { data: number, error, isLoading } = useNumber(id);
  const keys = useQuery({ queryKey: ["wa-number", id, "keys"], queryFn: () => getWaKeys(id) });
  const addKey = useMutation({
    mutationFn: () => createWaKey(id),
    onSuccess: (r) => {
      setShownKey(r.apiKey);
      void keys.refetch();
    },
    onError: failedToast(toast, t("Failed to create an API key")),
  });
  const revoke = useMutation({ mutationFn: (keyId: string) => revokeWaKey(id, keyId), onSuccess: () => void keys.refetch(), onError: failedToast(toast, t("Failed to revoke the key")) });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t("API & keys")} — {number?.name ?? ""}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {isLoading ? (
            <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
          ) : error ? (
            <p className="text-sm text-destructive">{(error as Error).message}</p>
          ) : number ? (
            <>
              <section className="space-y-2">
                <Label>{t("Base URL")}</Label>
                <CopyField value={`${number.gatewayUrl}/v1/instances/${number.instanceId}`} />
                <p className="text-xs text-muted-foreground">
                  {t("Send the key as")} <code className="font-mono">x-api-key</code>.{" "}
                  <a href={`${number.gatewayUrl}/docs`} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">
                    {t("API reference")}
                  </a>
                </p>
                <pre className="overflow-x-auto rounded-md bg-muted/60 p-3 font-mono text-[11px] leading-relaxed">
                  {`curl -X POST ${number.gatewayUrl}/v1/instances/${number.instanceId}/messages \\
  -H "x-api-key: lwg_…" -H "content-type: application/json" \\
  -d '{"to":"08123456789","text":"Halo!"}'`}
                </pre>
              </section>

              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t("API keys")}</Label>
                  <Button variant="outline" size="sm" disabled={addKey.isPending} onClick={() => addKey.mutate()}>
                    <KeyRound className="mr-2 h-3.5 w-3.5" />
                    {t("New key")}
                  </Button>
                </div>
                {shownKey && (
                  <div className="space-y-1">
                    <CopyField value={shownKey} />
                    <p className="text-xs text-warning">{t("Copy it now — it is not shown again.")}</p>
                  </div>
                )}
                <div className="divide-y rounded-md border text-sm">
                  {(keys.data ?? []).map((key) => (
                    <div key={key.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="font-mono text-xs">{key.prefix}…</span>
                      <span className="flex-1 text-xs text-muted-foreground">
                        {key.lastUsedAt ? t("Last used {date}", { date: new Date(key.lastUsedAt).toLocaleString(locale) }) : t("Never used")}
                      </span>
                      {key.revokedAt ? (
                        <Badge variant="outline">{t("Revoked")}</Badge>
                      ) : (
                        <Button variant="ghost" size="sm" className="text-destructive" disabled={revoke.isPending} onClick={() => revoke.mutate(key.id)}>
                          {t("Revoke")}
                        </Button>
                      )}
                    </div>
                  ))}
                  {keys.data?.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">{t("No keys yet.")}</p>}
                </div>
              </section>
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("Close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Who may call the API, where events go, and the secret they are signed with. */
function AccessDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { toast } = useToast();
  const { data: number, error, isLoading } = useNumber(id);
  const [form, setForm] = useState<{ ipAllowlist: string; webhookUrl: string } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  // the form fills once the number has loaded
  const values = form ?? (number ? { ipAllowlist: number.ipAllowlist.join(", "), webhookUrl: number.webhookUrl ?? "" } : null);
  const save = useMutation({
    mutationFn: (s: { ipAllowlist: string; webhookUrl: string }) => updateWaNumber(id, s),
    onSuccess: () => {
      toast({ title: t("Saved") });
      onClose();
    },
    onError: failedToast(toast, t("Failed to save the number")),
  });
  const showSecret = useMutation({ mutationFn: () => getWebhookSecret(id), onSuccess: (r) => setSecret(r.webhookSecret), onError: failedToast(toast, t("Failed to fetch the webhook secret")) });
  const rotateSecret = useMutation({ mutationFn: () => rotateWebhookSecret(id), onSuccess: (r) => setSecret(r.webhookSecret), onError: failedToast(toast, t("Failed to rotate the webhook secret")) });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("Access & webhook")} — {number?.name ?? ""}
          </DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
        ) : error ? (
          <p className="text-sm text-destructive">{(error as Error).message}</p>
        ) : values ? (
          <form
            id="number-access"
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(values);
            }}
          >
            <IpAllowlistField value={values.ipAllowlist} onChange={(ipAllowlist) => setForm({ ...values, ipAllowlist })} />
            <WebhookField value={values.webhookUrl} onChange={(webhookUrl) => setForm({ ...values, webhookUrl })} />
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Label>{t("Webhook secret")}</Label>
                {!secret && (
                  <Button type="button" variant="ghost" size="sm" className="h-7" disabled={showSecret.isPending} onClick={() => showSecret.mutate()}>
                    {t("Show")}
                  </Button>
                )}
                <Button type="button" variant="ghost" size="sm" className="h-7" disabled={rotateSecret.isPending} onClick={() => rotateSecret.mutate()}>
                  {t("New secret")}
                </Button>
              </div>
              {secret && <CopyField value={secret} />}
              <p className="text-xs text-muted-foreground">
                {t("Each webhook carries")} <code className="font-mono">x-larika-signature: sha256=HMAC(secret, body)</code>.
              </p>
            </div>
          </form>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            {t("Cancel")}
          </Button>
          <Button type="submit" form="number-access" disabled={save.isPending || !values?.ipAllowlist.trim()}>
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ row, onClose }: { row: Pick<WaNumber, "id" | "name">; onClose: () => void }) {
  const { toast } = useToast();
  const remove = useMutation({ mutationFn: () => deleteWaNumber(row.id), onSuccess: onClose, onError: failedToast(toast, t("Failed to delete the number")) });
  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Delete {name}?", { name: row.name })}</AlertDialogTitle>
          <AlertDialogDescription>{t("WhatsApp is logged out on the phone, and the number's messages, media and API keys are deleted from the gateway.")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>{t("Cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={remove.isPending}
            onClick={(e) => {
              e.preventDefault();
              remove.mutate();
            }}
          >
            {remove.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("Delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
