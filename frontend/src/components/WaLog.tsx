import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { callWaApi, type WaNumber } from "@/lib/waGateway";
import { locale, t } from "@/lib/i18n";

/** A message handed to the gateway to send, as it keeps it (its outbox). */
type Sent = {
  id: string;
  ref: string | null;
  to: string;
  text: string | null;
  mediaUrl: string | null;
  /** QUEUED | SENDING | SENT | FAILED | EXPIRED | CANCELLED */
  status: string;
  attempts: number;
  error: string | null;
  waMessageId: string | null;
  /** WhatsApp's latest receipt: SENT | DELIVERED | READ */
  receipt: string | null;
  sentAt: string | null;
  createdAt: string;
};

const STATUSES = ["QUEUED", "SENDING", "SENT", "FAILED", "EXPIRED", "CANCELLED"] as const;
const ALL = "__all__";

const statusLabel = (status: string) =>
  ({ QUEUED: t("Queued"), SENDING: t("Sending"), SENT: t("Sent"), FAILED: t("Failed"), EXPIRED: t("Expired"), CANCELLED: t("Cancelled") })[status] ?? status;
const receiptLabel = (receipt: string | null) => ({ SENT: t("Sent"), DELIVERED: t("Delivered"), READ: t("Read") })[receipt ?? ""] ?? "—";
const when = (value: string | null) => (value ? new Date(value).toLocaleString(locale, { dateStyle: "short", timeStyle: "medium" }) : "—");

function StatusBadge({ status }: { status: string }) {
  if (status === "FAILED") return <Badge variant="destructive">{statusLabel(status)}</Badge>;
  if (status === "SENT") return <Badge className="bg-success text-success-foreground hover:bg-success">{statusLabel(status)}</Badge>;
  return <Badge variant="outline">{statusLabel(status)}</Badge>;
}

/**
 * What a number was asked to send, newest first: did it go out, did it arrive,
 * and why not. Read through the Playground's proxy (the number's own
 * `GET /messages`), so like the Playground it is for the numbers one manages.
 * ponytail: the gateway's newest 500 per number, no older page — paging on the gateway when a longer history is wanted
 */
export function WaLogTab({ rows }: { rows: WaNumber[] }) {
  const query = useTableQuery(25);
  const numbers = rows.filter((r) => r.canManage);
  const [picked, setPicked] = useState("");
  const number = numbers.find((r) => r.id === picked) ?? numbers[0];
  const [status, setStatus] = useState(ALL);
  const [open, setOpen] = useState<Sent | null>(null);

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ["wa-log", number?.id, status],
    queryFn: async () => {
      const r = await callWaApi(number!.id, { method: "GET", path: "/messages", query: { limit: "500", ...(status !== ALL && { status }) } });
      if (!r.ok) throw new Error(t("The gateway refused: {reason}", { reason: JSON.stringify(r.response) }));
      return r.response as Sent[];
    },
    enabled: !!number,
    refetchInterval: 10_000,
  });

  const columns: Column<Sent>[] = [
    { header: t("Time"), className: "w-44 whitespace-nowrap text-xs text-muted-foreground", cell: (m) => when(m.createdAt) },
    { header: t("To"), className: "w-44", cell: (m) => <span className="block truncate font-mono text-xs">{m.to}</span> },
    {
      header: t("Message"),
      cell: (m) => <span className="block truncate text-sm">{m.text || (m.mediaUrl ? t("(media)") : "—")}</span>,
    },
    { header: t("Status"), className: "w-28", cell: (m) => <StatusBadge status={m.status} /> },
    { header: t("Receipt"), className: "w-24 text-sm", cell: (m) => <span className={m.receipt === "READ" ? "text-primary" : "text-muted-foreground"}>{receiptLabel(m.receipt)}</span> },
    { header: t("Error"), className: "w-[22%]", cell: (m) => <span className="block truncate text-xs text-destructive" title={m.error ?? undefined}>{m.error ?? ""}</span> },
  ];

  if (!numbers.length) return <p className="text-sm text-muted-foreground">{t("No number you manage yet: the log shows what your numbers were asked to send.")}</p>;

  return (
    <>
      {error && <p className="mb-3 text-sm text-destructive">{(error as Error).message}</p>}
      <DataTable
        columns={columns}
        rows={data ?? []}
        rowKey={(m) => m.id}
        query={query}
        filter={(m, search) => `${m.to} ${m.ref ?? ""} ${m.text ?? ""} ${m.error ?? ""}`.toLowerCase().includes(search.toLowerCase())}
        isLoading={isFetching && !data}
        searchPlaceholder={t("Search recipient, text or ref…")}
        empty={t("Nothing sent yet.")}
        onRowClick={(m) => setOpen(m)}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <Select value={number?.id ?? ""} onValueChange={setPicked}>
              <SelectTrigger className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {numbers.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                    {r.phone ? ` (+${r.phone})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("Every status")}</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {statusLabel(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" onClick={() => void refetch()} disabled={isFetching}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} /> {t("Refresh")}
            </Button>
          </div>
        }
      />

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("Message to {to}", { to: open?.to ?? "" })}</DialogTitle>
          </DialogHeader>
          {open && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                <span className="text-muted-foreground">{t("Status")}</span>
                <span>
                  <StatusBadge status={open.status} />
                </span>
                <span className="text-muted-foreground">{t("Receipt")}</span>
                <span>{receiptLabel(open.receipt)}</span>
                <span className="text-muted-foreground">{t("Asked")}</span>
                <span>{when(open.createdAt)}</span>
                <span className="text-muted-foreground">{t("Sent")}</span>
                <span>{when(open.sentAt)}</span>
                <span className="text-muted-foreground">{t("Attempts")}</span>
                <span>{open.attempts}</span>
                <span className="text-muted-foreground">ref</span>
                <span className="break-all font-mono">{open.ref ?? "—"}</span>
                <span className="text-muted-foreground">id</span>
                <span className="break-all font-mono">{open.id}</span>
                {open.waMessageId && (
                  <>
                    <span className="text-muted-foreground">WhatsApp id</span>
                    <span className="break-all font-mono">{open.waMessageId}</span>
                  </>
                )}
                {open.mediaUrl && (
                  <>
                    <span className="text-muted-foreground">{t("Media")}</span>
                    <span className="break-all font-mono">{open.mediaUrl}</span>
                  </>
                )}
              </div>
              {open.error && <p className="rounded-md border border-destructive/40 p-2 text-xs text-destructive">{open.error}</p>}
              {open.text && <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-3 text-xs">{open.text}</pre>}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
