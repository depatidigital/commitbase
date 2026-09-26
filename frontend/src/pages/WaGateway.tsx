import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { KeyRound, Loader2, MessageCircle, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
    <span className="flex items-center gap-2 text-sm">
      <span className={`h-2 w-2 shrink-0 rounded-full ${s.dot}`} />
      {s.label()}
    </span>
  );
}

/**
 * A workspace's WhatsApp numbers on the Larika gateway: link one by QR, then an
 * app sends and receives through the gateway's API with the number's key.
 */
export default function WaGateway() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = useTableQuery(25);
  const [adding, setAdding] = useState<{ name: string; organizationId: string; ipAllowlist: string; webhookUrl: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);

  const { data, isFetching } = useQuery({ queryKey: LIST_KEY, queryFn: getWaNumbers, refetchInterval: 30_000 });
  const rows = data?.rows ?? [];
  const { data: orgs = [] } = useQuery({ queryKey: ["organizations"], queryFn: getOrganizations, enabled: !!adding });
  // who may add: platform admins, or owners/admins of a workspace
  const manageable = orgs.filter((org) => isAdmin() || org.myRole === "OWNER" || org.myRole === "ADMIN");
  const showWorkspace = isAdmin() || new Set(rows.map((r) => r.organization.id)).size > 1;

  const create = useMutation({
    mutationFn: createWaNumber,
    onSuccess: (created) => {
      setAdding(null);
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
      setOpenId(created.id);
      setNewKey(created.apiKey);
    },
    onError: (e: Error) => toast({ title: t("Failed to add the number"), description: e.message, variant: "destructive" }),
  });

  const columns: Column<WaNumber>[] = [
    {
      header: t("Name"),
      cell: (row) => (
        <div className="min-w-0">
          <div className="font-medium">{row.name}</div>
          {showWorkspace && <div className="text-xs text-muted-foreground">{row.organization.name}</div>}
        </div>
      ),
    },
    { header: t("Status"), cell: (row) => <StatusDot status={row.status} /> },
    { header: t("Number"), cell: (row) => <span className="font-mono text-sm">{row.phone ? `+${row.phone}` : "—"}</span> },
    { header: t("Sent (24h)"), cell: (row) => <span className="tabular-nums">{row.sent24h}</span> },
    {
      header: t("Node"),
      cell: (row) => (row.status && row.status !== "MISSING" ? <span className="text-xs text-muted-foreground">{row.nodeOnline ? t("Online") : t("Offline")}</span> : "—"),
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
        onRowClick={(row) => setOpenId(row.id)}
      />

      <Dialog open={!!adding} onOpenChange={(open) => !open && setAdding(null)}>
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

      {openId && (
        <NumberDialog
          id={openId}
          firstKey={newKey}
          onClose={() => {
            setOpenId(null);
            setNewKey(null);
            void queryClient.invalidateQueries({ queryKey: LIST_KEY });
          }}
        />
      )}
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

/** One number: link it by QR, its API keys, webhook, and relink/restart/delete. */
function NumberDialog({ id, firstKey, onClose }: { id: string; firstKey: string | null; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [shownKey, setShownKey] = useState<string | null>(firstKey);
  const [secret, setSecret] = useState<string | null>(null);
  const [settings, setSettings] = useState<{ ipAllowlist: string; webhookUrl: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const detailKey = ["wa-number", id];
  const { data: number, error, isLoading } = useQuery({
    queryKey: detailKey,
    queryFn: () => getWaNumber(id),
    // the QR changes every ~20 s and the scan flips it ONLINE: poll fast until then
    refetchInterval: (q) => (q.state.data && q.state.data.status === "ONLINE" ? 15_000 : 2_000),
    retry: false,
  });
  const keys = useQuery({ queryKey: [...detailKey, "keys"], queryFn: () => getWaKeys(id), enabled: !!number?.canManage });
  const failed = (title: string) => (e: Error) => toast({ title, description: e.message, variant: "destructive" });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: detailKey });

  const relink = useMutation({ mutationFn: () => relinkWaNumber(id), onSuccess: refresh, onError: failed(t("Failed to relink the number")) });
  const restart = useMutation({ mutationFn: () => restartWaNumber(id), onSuccess: refresh, onError: failed(t("Failed to restart the number")) });
  const addKey = useMutation({
    mutationFn: () => createWaKey(id),
    onSuccess: (r) => {
      setShownKey(r.apiKey);
      void keys.refetch();
    },
    onError: failed(t("Failed to create an API key")),
  });
  const revoke = useMutation({ mutationFn: (keyId: string) => revokeWaKey(id, keyId), onSuccess: () => void keys.refetch(), onError: failed(t("Failed to revoke the key")) });
  const showSecret = useMutation({ mutationFn: () => getWebhookSecret(id), onSuccess: (r) => setSecret(r.webhookSecret), onError: failed(t("Failed to fetch the webhook secret")) });
  const rotateSecret = useMutation({ mutationFn: () => rotateWebhookSecret(id), onSuccess: (r) => setSecret(r.webhookSecret), onError: failed(t("Failed to rotate the webhook secret")) });
  const save = useMutation({
    mutationFn: (s: { ipAllowlist: string; webhookUrl: string }) => updateWaNumber(id, s),
    onSuccess: () => {
      setSettings(null);
      refresh();
      toast({ title: t("Saved") });
    },
    onError: failed(t("Failed to save the number")),
  });
  const remove = useMutation({ mutationFn: () => deleteWaNumber(id), onSuccess: onClose, onError: failed(t("Failed to delete the number")) });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{number?.name ?? t("WhatsApp number")}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-6">
          {isLoading ? (
            <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
          ) : error ? (
            <p className="text-sm text-destructive">{(error as Error).message}</p>
          ) : number ? (
            <>
              {/* link: the QR while it waits, who it is once linked */}
              <section className="flex flex-col items-center gap-3 rounded-md border p-4 text-center">
                <StatusDot status={number.status} />
                {number.status === "QR" && number.qr ? (
                  <>
                    <div className="rounded-md bg-white p-3">
                      <QRCodeSVG value={number.qr} size={220} />
                    </div>
                    <p className="max-w-sm text-xs text-muted-foreground">{t("On the phone: WhatsApp → Linked devices → Link a device, then scan this code.")}</p>
                  </>
                ) : number.status === "ONLINE" ? (
                  <p className="text-sm">
                    {number.profileName && <span className="font-medium">{number.profileName} · </span>}
                    <span className="font-mono">{number.phone ? `+${number.phone}` : ""}</span>
                  </p>
                ) : number.status === "QR" && !number.canManage ? (
                  <p className="text-xs text-muted-foreground">{t("Waiting for a workspace owner or admin to scan the QR code.")}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("The QR code shows here once the number's WA node is ready.")}</p>
                )}
                {number.error && <p className="text-xs text-destructive">{number.error}</p>}
                {number.usage && (
                  <p className="text-xs text-muted-foreground">
                    {t("{sent} of {cap} messages sent in 24 hours · {queued} queued", { sent: number.usage.sent24h, cap: number.usage.dailyCap, queued: number.usage.queued })}
                  </p>
                )}
                {number.canManage && (
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={restart.isPending} onClick={() => restart.mutate()}>
                      <RefreshCw className={`mr-2 h-3.5 w-3.5 ${restart.isPending ? "animate-spin" : ""}`} />
                      {t("Restart")}
                    </Button>
                    {/* relinking logs the phone out: only offered while it is not linked (Delete covers the rest) */}
                    {number.status !== "ONLINE" && (
                      <Button variant="outline" size="sm" disabled={relink.isPending} onClick={() => relink.mutate()}>
                        <RotateCcw className="mr-2 h-3.5 w-3.5" />
                        {t("New QR code")}
                      </Button>
                    )}
                  </div>
                )}
              </section>

              {/* the API: base URL, the number's id, a key */}
              <section className="space-y-2">
                <h3 className="text-sm font-medium">API</h3>
                <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-xs">
                  <span className="text-muted-foreground">{t("Base URL")}</span>
                  <CopyField value={`${number.gatewayUrl}/v1/instances/${number.instanceId}`} />
                </div>
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

              {number.canManage && (
                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium">{t("API keys")}</h3>
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
              )}

              {number.canManage && (
                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium">{t("Webhook and access")}</h3>
                    {!settings && (
                      <Button variant="outline" size="sm" onClick={() => setSettings({ ipAllowlist: number.ipAllowlist.join(", "), webhookUrl: number.webhookUrl ?? "" })}>
                        {t("Edit")}
                      </Button>
                    )}
                  </div>
                  {settings ? (
                    <form
                      className="space-y-3"
                      onSubmit={(e) => {
                        e.preventDefault();
                        save.mutate(settings);
                      }}
                    >
                      <IpAllowlistField value={settings.ipAllowlist} onChange={(ipAllowlist) => setSettings({ ...settings, ipAllowlist })} />
                      <WebhookField value={settings.webhookUrl} onChange={(webhookUrl) => setSettings({ ...settings, webhookUrl })} />
                      <div className="flex justify-end gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={() => setSettings(null)}>
                          {t("Cancel")}
                        </Button>
                        <Button type="submit" size="sm" disabled={save.isPending || !settings.ipAllowlist.trim()}>
                          {save.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                          {t("Save")}
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                      <span className="text-muted-foreground">{t("Allowed IPs")}</span>
                      <span className="break-all font-mono">{number.ipAllowlist.join(", ") || "—"}</span>
                      <span className="text-muted-foreground">Webhook URL</span>
                      <span className="break-all font-mono">{number.webhookUrl || "—"}</span>
                    </div>
                  )}
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{t("Webhook secret")}</span>
                      {!secret && (
                        <Button variant="ghost" size="sm" className="h-7" disabled={showSecret.isPending} onClick={() => showSecret.mutate()}>
                          {t("Show")}
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" className="h-7" disabled={rotateSecret.isPending} onClick={() => rotateSecret.mutate()}>
                        {t("New secret")}
                      </Button>
                    </div>
                    {secret && <CopyField value={secret} />}
                    <p className="text-xs text-muted-foreground">
                      {t("Each webhook carries")} <code className="font-mono">x-larika-signature: sha256=HMAC(secret, body)</code>.
                    </p>
                  </div>
                </section>
              )}
            </>
          ) : null}
        </DialogBody>
        <DialogFooter className="justify-between sm:justify-between">
          {number?.canManage ? (
            <Button variant="ghost" className="text-destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="mr-2 h-4 w-4" />
              {t("Delete")}
            </Button>
          ) : (
            <span />
          )}
          <Button variant="outline" onClick={onClose}>
            {t("Close")}
          </Button>
        </DialogFooter>

        <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("Delete {name}?", { name: number?.name ?? "" })}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("WhatsApp is logged out on the phone, and the number's messages, media and API keys are deleted from the gateway.")}
              </AlertDialogDescription>
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
      </DialogContent>
    </Dialog>
  );
}
