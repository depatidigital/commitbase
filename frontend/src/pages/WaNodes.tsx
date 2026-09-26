import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, KeyRound, Link2, Loader2, MoreVertical, Plus, ShieldOff, Smartphone, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { CopyField } from "@/components/CopyField";
import { deleteWaNode, getWaNodeConnect, getWaNodes, pairWaNode, revokeWaNode, updateWaNodes, type PairResult, type WaNode } from "@/lib/waGateway";
import { formatBytes } from "@/lib/utils";
import { locale, t } from "@/lib/i18n";

const QUERY_KEY = ["wa-nodes"];

/**
 * The PCs that run WhatsApp for the Larika gateway (its "agents"). Each dials
 * out to the gateway; pairing hands it a connect string (lwa1_…) to paste into
 * the agent. Numbers are placed on the least-loaded online node.
 */
export default function WaNodes() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = useTableQuery(25);
  // pairing: a new node (no agentId) or the same one again
  const [pairing, setPairing] = useState<{ name: string; permanent: boolean; agentId?: string } | null>(null);
  const [paired, setPaired] = useState<PairResult | null>(null);
  const [confirm, setConfirm] = useState<{ node: WaNode; action: "revoke" | "delete" } | null>(null);

  const { data: nodes = [], isFetching, error } = useQuery({ queryKey: QUERY_KEY, queryFn: getWaNodes, refetchInterval: 15_000, retry: false });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  const failed = (title: string) => (e: Error) => toast({ title, description: e.message, variant: "destructive" });

  const pair = useMutation({
    mutationFn: pairWaNode,
    onSuccess: (result) => {
      setPairing(null);
      setPaired(result);
      refresh();
    },
    onError: failed(t("Failed to pair the node")),
  });
  const showConnect = useMutation({
    mutationFn: (node: WaNode) => getWaNodeConnect(node.id).then((r) => ({ id: node.id, permanent: true, connect: r.connect })),
    onSuccess: setPaired,
    onError: failed(t("Failed to fetch the connect string")),
  });
  const act = useMutation({
    mutationFn: ({ node, action }: { node: WaNode; action: "revoke" | "delete" }) => (action === "revoke" ? revokeWaNode(node.id) : deleteWaNode(node.id)),
    onSuccess: (_, { action }) => {
      setConfirm(null);
      refresh();
      toast({ title: action === "revoke" ? t("Node disconnected") : t("Node deleted") });
    },
    onError: failed(t("That did not work")),
  });
  const update = useMutation({
    mutationFn: updateWaNodes,
    onSuccess: () => toast({ title: t("Online nodes will check for an update now") }),
    onError: failed(t("Failed to ask the nodes to update")),
  });

  const columns: Column<WaNode>[] = [
    {
      header: t("Node"),
      cell: (node) => (
        <div className="min-w-0">
          <div className="font-medium">{node.name}</div>
          {node.version && <div className="font-mono text-xs text-muted-foreground">v{node.version}</div>}
        </div>
      ),
    },
    {
      header: t("Status"),
      cell: (node) => (
        <span className="flex items-center gap-2 text-sm">
          <span className={`h-2 w-2 shrink-0 rounded-full ${node.online ? "bg-success" : "bg-muted-foreground/40"}`} />
          {node.online ? t("Online") : !node.paired ? t("Waiting to be paired") : t("Offline")}
        </span>
      ),
    },
    { header: t("Numbers"), cell: (node) => <span className="tabular-nums">{node.instances} / {node.capacity}</span> },
    { header: t("Data"), cell: (node) => (node.diskBytes != null ? formatBytes(node.diskBytes) : "—") },
    {
      header: t("Last seen"),
      cell: (node) => <span className="text-xs text-muted-foreground">{node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleString(locale) : "—"}</span>,
    },
    {
      header: "",
      className: "w-16 text-right",
      cell: (node) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label={t("Actions for {name}", { name: node.name })}>
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {node.permanent && (
              <DropdownMenuItem onClick={() => showConnect.mutate(node)}>
                <Link2 className="mr-2 h-4 w-4" />
                {t("Show connect string")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => setPairing({ name: node.name, permanent: false, agentId: node.id })}>
              <KeyRound className="mr-2 h-4 w-4" />
              {t("Pair again")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!node.online || update.isPending} onClick={() => update.mutate(node.id)}>
              <ArrowUpCircle className="mr-2 h-4 w-4" />
              {t("Check for update")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!node.paired} onClick={() => setConfirm({ node, action: "revoke" })}>
              <ShieldOff className="mr-2 h-4 w-4" />
              {t("Disconnect")}
            </DropdownMenuItem>
            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setConfirm({ node, action: "delete" })}>
              <Trash2 className="mr-2 h-4 w-4" />
              {t("Delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <PageLayout
      icon={Smartphone}
      title="WA Node"
      description={t("The PCs that run WhatsApp for the Larika gateway. Each one dials out to the gateway; new numbers go to the least-loaded online node.")}
      actions={
        <div className="flex gap-2">
          <Button variant="outline" disabled={update.isPending || !nodes.some((n) => n.online)} onClick={() => update.mutate(undefined)}>
            <ArrowUpCircle className="mr-2 h-4 w-4" /> {t("Update all")}
          </Button>
          <Button onClick={() => setPairing({ name: "", permanent: false })}>
            <Plus className="mr-2 h-4 w-4" /> {t("Pair a node")}
          </Button>
        </div>
      }
    >
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      <DataTable
        columns={columns}
        rows={nodes}
        rowKey={(node) => node.id}
        query={query}
        filter={(node, search) => node.name.toLowerCase().includes(search.toLowerCase())}
        isLoading={isFetching && !nodes.length}
        searchPlaceholder={t("Search nodes…")}
        empty={t("No WA nodes yet. Pair a PC running the Larika WA agent.")}
      />

      <Dialog open={!!pairing} onOpenChange={(open) => !open && setPairing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pairing?.agentId ? t("Pair {name} again", { name: pairing.name }) : t("Pair a node")}</DialogTitle>
            <DialogDescription>
              {pairing?.agentId
                ? t("A new connect string for this node. Once a PC uses it, the PC that had the node before is disconnected.")
                : t("You get a connect string to paste into the Larika WA agent on the PC.")}
            </DialogDescription>
          </DialogHeader>
          {pairing && (
            <form
              id="pair-node"
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                pair.mutate(pairing);
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="node-name">{t("Name")}</Label>
                <Input id="node-name" autoFocus maxLength={80} placeholder="PC-Kantor-1" value={pairing.name} onChange={(e) => setPairing({ ...pairing, name: e.target.value })} />
              </div>
              <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm">
                <Checkbox checked={pairing.permanent} onCheckedChange={(checked) => setPairing({ ...pairing, permanent: checked === true })} className="mt-0.5" />
                <span>
                  <span className="font-medium">{t("Does not expire")}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t("For setting a PC up later or remotely. Still works once only. Without it, the string is valid for 10 minutes and the node takes the PC's name.")}
                  </span>
                </span>
              </label>
            </form>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPairing(null)} disabled={pair.isPending}>
              {t("Cancel")}
            </Button>
            <Button type="submit" form="pair-node" disabled={pair.isPending || !pairing?.name.trim()}>
              {pair.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("Get connect string")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!paired} onOpenChange={(open) => !open && setPaired(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Connect string")}</DialogTitle>
            <DialogDescription>
              {paired?.permanent
                ? t("Paste it into the Larika WA agent on the PC. It works once and does not expire.")
                : t("Paste it into the Larika WA agent on the PC. It works once, until {time}.", {
                    time: paired?.pairExpiresAt ? new Date(paired.pairExpiresAt).toLocaleTimeString(locale) : "",
                  })}
            </DialogDescription>
          </DialogHeader>
          {paired && (
            <div className="space-y-3">
              <CopyField value={paired.connect} />
              {paired.pairCode && (
                <p className="text-xs text-muted-foreground">
                  {t("Or type the code:")} <span className="font-mono text-sm text-foreground">{paired.pairCode}</span>
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setPaired(null)}>{t("Done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirm} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.action === "revoke" ? t("Disconnect {name}?", { name: confirm.node.name }) : t("Delete {name}?", { name: confirm?.node.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.action === "revoke"
                ? t("The PC is cut off and its numbers go offline. The node stays; pair it again to bring it back.")
                : t("Its {count} numbers go offline until they are moved to another node — each then needs its QR scanned again.", { count: confirm?.node.instances ?? 0 })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={act.isPending}>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={act.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (confirm) act.mutate(confirm);
              }}
            >
              {act.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {confirm?.action === "revoke" ? t("Disconnect") : t("Delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageLayout>
  );
}
