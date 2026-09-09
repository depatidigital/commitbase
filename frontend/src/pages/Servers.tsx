import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { HardDrive, Loader2, Plus, RefreshCw, Trash2, Pencil } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import {
  Server,
  ServerInput,
  createServer,
  deleteServer,
  getServersPage,
  pingServer,
  updateServer,
} from "@/lib/servers";

const BLANK: ServerInput = {
  name: "",
  hostname: "",
  sshUser: "commitbase",
  sshPort: 22,
  sshKeyPath: "",
  publicIp: "",
  caddyApiUrl: "",
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  ONLINE: "default",
  OFFLINE: "destructive",
  UNKNOWN: "secondary",
};

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

export default function Servers() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = useTableQuery();

  const [open, setOpen] = useState(false);
  // The row being edited, or null when the dialog is registering a new node.
  const [editing, setEditing] = useState<Server | null>(null);
  const [form, setForm] = useState<ServerInput>(BLANK);
  const [confirmDelete, setConfirmDelete] = useState<Server | null>(null);

  const { data, isFetching } = useQuery({
    queryKey: ["servers", "page", query.params],
    queryFn: () => getServersPage(query.params),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["servers"] });
  const fail = (error: Error) =>
    toast({ title: "Error", description: error.message, variant: "destructive" });

  const openNew = () => {
    setEditing(null);
    setForm(BLANK);
    setOpen(true);
  };

  const openEdit = (server: Server) => {
    setEditing(server);
    setForm({
      name: server.name,
      hostname: server.hostname,
      sshUser: server.sshUser,
      sshPort: server.sshPort,
      sshKeyPath: server.sshKeyPath,
      publicIp: server.publicIp,
      caddyApiUrl: server.caddyApiUrl,
    });
    setOpen(true);
  };

  const saveMutation = useMutation({
    mutationFn: () => (editing ? updateServer(editing.id, form) : createServer(form)),
    onSuccess: (server) => {
      refresh();
      setOpen(false);
      toast({
        title: editing ? "Server updated" : "Server registered",
        // A new node is pinged on create, so its verdict is already meaningful.
        description: editing ? undefined : `Reachability: ${server.status}`,
      });
    },
    onError: fail,
  });

  const pingMutation = useMutation({
    mutationFn: pingServer,
    onSuccess: (result) => {
      refresh();
      toast({
        title: `${result.name} is ${result.status}`,
        description: result.error,
        variant: result.status === "ONLINE" ? undefined : "destructive",
      });
    },
    onError: fail,
  });

  const deleteMutation = useMutation({
    mutationFn: (server: Server) => deleteServer(server.id),
    onSuccess: () => {
      refresh();
      setConfirmDelete(null);
      toast({ title: "Server deleted" });
    },
    onError: (error: Error) => {
      setConfirmDelete(null);
      fail(error);
    },
  });

  const columns: Column<Server>[] = [
    {
      header: "Name",
      className: "w-[20%]",
      cell: (s) => (
        <div className="min-w-0">
          <span className="block truncate font-medium">{s.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{s.publicIp}</span>
        </div>
      ),
    },
    {
      header: "SSH",
      className: "w-[24%]",
      cell: (s) => (
        <span className="block truncate text-muted-foreground">
          {s.sshUser}@{s.hostname}:{s.sshPort}
        </span>
      ),
    },
    {
      header: "Status",
      className: "w-32",
      cell: (s) => (
        <div className="space-y-1">
          <Badge variant={STATUS_VARIANT[s.status] ?? "secondary"}>{s.status}</Badge>
          <span className="block text-xs text-muted-foreground">{ago(s.lastSeenAt)}</span>
        </div>
      ),
    },
    { header: "Orgs", className: "w-20", cell: (s) => s._count.organizations },
    {
      header: "Last error",
      className: "w-[22%]",
      cell: (s) =>
        s.lastError ? (
          <span className="block truncate text-xs text-destructive" title={s.lastError}>
            {s.lastError}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      header: "",
      className: "w-40 text-right",
      cell: (s) => (
        <div className="flex justify-end gap-1">
          <Button
            size="sm"
            variant="outline"
            title="Check now"
            disabled={pingMutation.isPending}
            onClick={() => pingMutation.mutate(s.id)}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" title="Edit" onClick={() => openEdit(s)}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            title="Delete"
            onClick={() => setConfirmDelete(s)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ];

  const incomplete =
    !form.name.trim() || !form.hostname.trim() || !form.sshUser.trim() || !form.sshKeyPath.trim() || !form.publicIp.trim();

  return (
    <PageLayout
      icon={HardDrive}
      title="Servers"
      description="Provisioning nodes. Organizations are placed on a node from their organization page."
      actions={
        <Button onClick={openNew}>
          <Plus className="mr-2 h-4 w-4" /> Register server
        </Button>
      }
    >
      <DataTable
        columns={columns}
        rows={data?.data ?? []}
        rowKey={(s) => s.id}
        query={query}
        pagination={data?.pagination}
        isLoading={isFetching}
        searchPlaceholder="Search name, hostname or IP…"
        empty="No servers registered yet."
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveMutation.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>{editing ? `Edit ${editing.name}` : "Register server"}</DialogTitle>
              <DialogDescription>
                The control plane reaches this node over SSH. The key must already be
                authorized for {form.sshUser || "the SSH user"} on the box.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 py-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="srv-name">Name</Label>
                <Input
                  id="srv-name"
                  autoFocus
                  placeholder="node-2"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="srv-public-ip">Public IP</Label>
                <Input
                  id="srv-public-ip"
                  placeholder="203.0.113.10"
                  value={form.publicIp}
                  onChange={(e) => setForm({ ...form, publicIp: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Becomes the Cloudflare A record target for apps on this node.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="srv-hostname">SSH host</Label>
                <Input
                  id="srv-hostname"
                  placeholder="203.0.113.10"
                  value={form.hostname}
                  onChange={(e) => setForm({ ...form, hostname: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-[1fr_100px] gap-2">
                <div className="space-y-2">
                  <Label htmlFor="srv-ssh-user">SSH user</Label>
                  <Input
                    id="srv-ssh-user"
                    value={form.sshUser}
                    onChange={(e) => setForm({ ...form, sshUser: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="srv-ssh-port">Port</Label>
                  <Input
                    id="srv-ssh-port"
                    type="number"
                    value={form.sshPort}
                    onChange={(e) => setForm({ ...form, sshPort: Number(e.target.value) || 22 })}
                  />
                </div>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="srv-key">SSH key path</Label>
                <Input
                  id="srv-key"
                  placeholder="/home/commitbase/.ssh/id_ed25519"
                  value={form.sshKeyPath}
                  onChange={(e) => setForm({ ...form, sshKeyPath: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Path on the control plane, inside the configured key directory. Key
                  material is never stored in the database.
                </p>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="srv-caddy">Caddy admin API (optional)</Label>
                <Input
                  id="srv-caddy"
                  placeholder="http://127.0.0.1:2019"
                  value={form.caddyApiUrl}
                  onChange={(e) => setForm({ ...form, caddyApiUrl: e.target.value })}
                />
              </div>
            </div>

            <DialogFooter>
              <Button type="submit" disabled={incomplete || saveMutation.isPending}>
                {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {editing ? "Save" : "Register"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {confirmDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Only removes the node from the panel — nothing on the box is touched. A node
              with organizations placed on it cannot be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDelete && deleteMutation.mutate(confirmDelete)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageLayout>
  );
}
