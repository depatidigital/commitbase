import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Eye,
  HardDrive,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  ScrollText,
  Trash2,
  Wrench,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { ProvisionBadge } from "@/components/ProvisionBadge";
import { isProvisionPending } from "@/lib/organizations";
import { t } from "@/lib/i18n";
import {
  LogSource,
  Server,
  ServerInput,
  createServer,
  deleteServer,
  getServerLogs,
  getServersPage,
  pingServer,
  setupServer,
  updateServer,
} from "@/lib/servers";

const BLANK: ServerInput = {
  name: "",
  hostname: "",
  sshUser: "larika",
  sshPort: 22,
  authMethod: "KEY",
  sshKeyPath: "",
  sshPassword: "",
  publicIp: "",
  tags: [],
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  ONLINE: "default",
  OFFLINE: "destructive",
  UNKNOWN: "secondary",
};

const ago = (iso: string | null) => {
  if (!iso) return t("never");
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return t("{n}s ago", { n: seconds });
  if (seconds < 3600) return t("{n}m ago", { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return t("{n}h ago", { n: Math.floor(seconds / 3600) });
  return t("{n}d ago", { n: Math.floor(seconds / 86400) });
};

export default function Servers() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useTableQuery();

  const [open, setOpen] = useState(false);
  // The row being edited, or null when the dialog is registering a new node.
  const [editing, setEditing] = useState<Server | null>(null);
  const [form, setForm] = useState<ServerInput>(BLANK);
  const [confirmDelete, setConfirmDelete] = useState<Server | null>(null);
  // set by clicking a tag in the table; "" is no filter
  const [tagFilter, setTagFilter] = useState("");
  // the node whose logs are open, or null
  const [logsFor, setLogsFor] = useState<Server | null>(null);
  const [logSource, setLogSource] = useState<LogSource>("system");
  // the node about to be set up, and whether to add PHP-FPM
  const [confirmSetup, setConfirmSetup] = useState<Server | null>(null);
  const [withPhp, setWithPhp] = useState(false);
  // id of the node whose setup output is open — an id, so the dialog follows
  // the polled row and the output grows while the setup runs
  const [setupLogFor, setSetupLogFor] = useState<string | null>(null);
  const setupLogRef = useRef<HTMLPreElement>(null);

  const { data, isFetching } = useQuery({
    queryKey: ["servers", "page", query.params, tagFilter],
    queryFn: () => getServersPage(query.params, tagFilter),
    // every 2s while setup output is open (it opens before the list knows the
    // setup was queued), otherwise every 5s while a setup is queued or running
    refetchInterval: (q) =>
      setupLogFor ? 2000 : q.state.data?.data.some((s) => isProvisionPending(s.setupState)) ? 5000 : false,
  });
  const setupLogServer = data?.data.find((s) => s.id === setupLogFor) ?? null;

  // follow the tail, unless the reader scrolled up to look at something
  useEffect(() => {
    const el = setupLogRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [setupLogServer?.setupLog]);

  const { data: logs, isFetching: logsLoading, refetch: refetchLogs } = useQuery({
    queryKey: ["servers", logsFor?.id, "logs", logSource],
    queryFn: () => getServerLogs(logsFor!.id, logSource),
    enabled: !!logsFor,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["servers"] });
  const fail = (error: Error) =>
    toast({ title: t("Error"), description: error.message, variant: "destructive" });

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
      authMethod: server.authMethod,
      sshKeyPath: server.sshKeyPath ?? "",
      // never prefilled: the stored password does not come back from the API,
      // and blank means "keep the one already saved"
      sshPassword: "",
      publicIp: server.publicIp,
      tags: server.tags ?? [],
    });
    setOpen(true);
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      // only send the credential the chosen method actually uses, and drop an
      // empty password so an edit does not wipe the stored one
      const payload: ServerInput = {
        ...form,
        ...(form.authMethod === "KEY"
          ? { sshPassword: undefined }
          : { sshKeyPath: undefined, sshPassword: form.sshPassword || undefined }),
      };
      return editing ? updateServer(editing.id, payload) : createServer(payload);
    },
    onSuccess: (server) => {
      refresh();
      setOpen(false);
      toast({
        title: editing ? t("Server updated") : t("Server registered"),
        // A new node is pinged on create, so its verdict is already meaningful.
        description: editing ? undefined : t("Reachability: {status}", { status: server.status }),
      });
    },
    onError: fail,
  });

  const pingMutation = useMutation({
    mutationFn: pingServer,
    onSuccess: (result) => {
      refresh();
      toast({
        title: t("{name} is {status}", { name: result.name, status: result.status }),
        description: result.error,
        variant: result.status === "ONLINE" ? undefined : "destructive",
      });
    },
    onError: fail,
  });

  const setupMutation = useMutation({
    mutationFn: (server: Server) => setupServer(server.id, withPhp),
    onSuccess: (_, server) => {
      refresh();
      setConfirmSetup(null);
      setSetupLogFor(server.id);
    },
    onError: (error: Error) => {
      setConfirmSetup(null);
      fail(error);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (server: Server) => deleteServer(server.id),
    onSuccess: () => {
      refresh();
      setConfirmDelete(null);
      toast({ title: t("Server deleted") });
    },
    onError: (error: Error) => {
      setConfirmDelete(null);
      fail(error);
    },
  });

  const columns: Column<Server>[] = [
    {
      header: t("Name"),
      className: "w-[20%]",
      cell: (s) => (
        <div className="min-w-0">
          <Link to={`/servers/${s.id}`} className="block truncate font-medium hover:underline">
            {s.name}
          </Link>
          <span className="block truncate text-xs text-muted-foreground">{s.publicIp}</span>
        </div>
      ),
    },
    {
      header: "SSH",
      className: "w-[24%]",
      cell: (s) => (
        <div className="min-w-0">
          <span className="block truncate text-muted-foreground">
            {s.sshUser}@{s.hostname}:{s.sshPort}
          </span>
          <span className="block text-xs text-muted-foreground">
            {s.authMethod === "PASSWORD" ? t("password") : t("key")}
          </span>
        </div>
      ),
    },
    {
      header: t("Tags"),
      className: "w-[18%]",
      cell: (s) =>
        s.tags?.length ? (
          <div className="flex flex-wrap gap-1">
            {s.tags.map((tag) => (
              // clicking a tag filters the list to it — the point of tagging
              <Badge
                key={tag}
                variant="outline"
                className="cursor-pointer text-xs"
                onClick={() => setTagFilter(tag === tagFilter ? "" : tag)}
              >
                {tag}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      header: t("Status"),
      className: "w-44",
      cell: (s) => (
        <div className="space-y-1">
          <Badge variant={STATUS_VARIANT[s.status] ?? "secondary"}>{s.status}</Badge>
          {/* reachable but bare is a different problem from unreachable, and
              has a completely different fix, so it gets its own badge */}
          {s.status === "ONLINE" && !s.provisioned && (
            <Badge variant="outline" className="text-xs">
              {t("not provisioned")}
            </Badge>
          )}
          <span className="block text-xs text-muted-foreground">{ago(s.lastSeenAt)}</span>
        </div>
      ),
    },
    {
      header: t("Provisioning"),
      className: "w-32",
      cell: (s) => (
        <ProvisionBadge
          state={s.setupState}
          error={s.setupError}
          at={s.setupAt}
          onClick={s.setupLog || isProvisionPending(s.setupState) ? () => setSetupLogFor(s.id) : undefined}
        />
      ),
    },
    { header: t("Orgs"), className: "w-20", cell: (s) => s._count.organizations },
    {
      header: t("Last error"),
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
      className: "w-16 text-right",
      cell: (s) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label={t("Actions for {name}", { name: s.name })}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => navigate(`/servers/${s.id}`)}>
              <Eye className="mr-2 h-4 w-4" />
              {t("Manage")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={pingMutation.isPending}
              onClick={() => pingMutation.mutate(s.id)}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {t("Check now")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setLogSource("errors");
                setLogsFor(s);
              }}
            >
              <ScrollText className="mr-2 h-4 w-4" />
              {t("Logs")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={isProvisionPending(s.setupState)}
              onClick={() => {
                setWithPhp(false);
                setConfirmSetup(s);
              }}
            >
              <Wrench className="mr-2 h-4 w-4" />
              {t("Set up server")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openEdit(s)}>
              <Pencil className="mr-2 h-4 w-4" />
              {t("Edit")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => setConfirmDelete(s)}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t("Delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  const incomplete =
    !form.name.trim() ||
    !form.hostname.trim() ||
    !form.sshUser.trim() ||
    !form.publicIp.trim() ||
    (form.authMethod === "KEY"
      ? !form.sshKeyPath?.trim()
      : // an edit can leave it blank to keep the stored password
        !form.sshPassword?.trim() && !editing?.hasPassword);

  return (
    <PageLayout
      icon={HardDrive}
      title={t("Servers")}
      description={t("Provisioning nodes. Organizations are placed on a node from their organization page.")}
      actions={
        <Button onClick={openNew}>
          <Plus className="mr-2 h-4 w-4" /> {t("Register server")}
        </Button>
      }
    >
      {tagFilter && (
        <div className="mb-3 flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t("Filtered by tag")}</span>
          <Badge variant="secondary">{tagFilter}</Badge>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => setTagFilter("")}>
            {t("Clear")}
          </Button>
        </div>
      )}

      <DataTable
        columns={columns}
        rows={data?.data ?? []}
        rowKey={(s) => s.id}
        query={query}
        pagination={data?.pagination}
        isLoading={isFetching}
        searchPlaceholder={t("Search name, hostname or IP…")}
        empty={t("No servers registered yet.")}
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
              <DialogTitle>{editing ? t("Edit {name}", { name: editing.name }) : t("Register server")}</DialogTitle>
              <DialogDescription>
                {form.authMethod === "KEY"
                  ? t("The control plane reaches this node over SSH as {user} — the key must already be authorized on the box.", { user: form.sshUser || t("the SSH user") })
                  : t("The control plane reaches this node over SSH as {user} — the box must allow password authentication.", { user: form.sshUser || t("the SSH user") })}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 py-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="srv-name">{t("Name")}</Label>
                <Input
                  id="srv-name"
                  autoFocus
                  placeholder="node-2"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="srv-public-ip">{t("Public IP")}</Label>
                <Input
                  id="srv-public-ip"
                  placeholder="203.0.113.10"
                  value={form.publicIp}
                  onChange={(e) => setForm({ ...form, publicIp: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  {t("Becomes the Cloudflare A record target for apps on this node.")}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="srv-hostname">{t("SSH host")}</Label>
                <Input
                  id="srv-hostname"
                  placeholder="203.0.113.10"
                  value={form.hostname}
                  onChange={(e) => setForm({ ...form, hostname: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-[1fr_100px] gap-2">
                <div className="space-y-2">
                  <Label htmlFor="srv-ssh-user">{t("SSH user")}</Label>
                  <Input
                    id="srv-ssh-user"
                    value={form.sshUser}
                    onChange={(e) => setForm({ ...form, sshUser: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="srv-ssh-port">{t("Port")}</Label>
                  <Input
                    id="srv-ssh-port"
                    type="number"
                    value={form.sshPort}
                    onChange={(e) => setForm({ ...form, sshPort: Number(e.target.value) || 22 })}
                  />
                </div>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="srv-auth">{t("Authentication")}</Label>
                <Select
                  value={form.authMethod}
                  onValueChange={(value) =>
                    setForm({ ...form, authMethod: value as ServerInput["authMethod"] })
                  }
                >
                  <SelectTrigger id="srv-auth">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="KEY">{t("SSH key")}</SelectItem>
                    <SelectItem value="PASSWORD">{t("Password")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="srv-tags">{t("Tags")}</Label>
                <Input
                  id="srv-tags"
                  placeholder="production, jakarta, php8.3"
                  value={form.tags.join(", ")}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      // split on save rather than per keystroke, so a half-typed
                      // tag is not lost while the comma is still being reached
                      tags: e.target.value
                        .split(",")
                        .map((tag) => tag.trim())
                        .filter(Boolean),
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {t("Comma separated. Your own labels — used to group and filter nodes.")}
                </p>
              </div>

              {form.authMethod === "KEY" ? (
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="srv-key">{t("SSH key path")}</Label>
                  <Input
                    id="srv-key"
                    placeholder="/opt/larika/.ssh/id_ed25519"
                    value={form.sshKeyPath ?? ""}
                    onChange={(e) => setForm({ ...form, sshKeyPath: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("Path on the control plane, inside the configured key directory. Key material is never stored in the database.")}
                  </p>
                </div>
              ) : (
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="srv-password">{t("SSH password")}</Label>
                  <Input
                    id="srv-password"
                    type="password"
                    autoComplete="new-password"
                    placeholder={
                      editing?.hasPassword ? t("Unchanged — type to replace") : t("The node's SSH password")
                    }
                    value={form.sshPassword ?? ""}
                    onChange={(e) => setForm({ ...form, sshPassword: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("Encrypted before it is stored and never returned by the API. Prefer a key where you can: a password does not work on a box with")}
                    <code className="mx-1">PasswordAuthentication no</code>.
                  </p>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button type="submit" disabled={incomplete || saveMutation.isPending}>
                {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {editing ? t("Save") : t("Register")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!logsFor} onOpenChange={(o) => !o && setLogsFor(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{t("Logs — {name}", { name: logsFor?.name ?? "" })}</DialogTitle>
            <DialogDescription>
              {t("Read over the same SSH connection the panel provisions with. Nothing is stored on the control plane.")}
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2">
            <Select value={logSource} onValueChange={(v) => setLogSource(v as LogSource)}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="errors">{t("Errors (all units)")}</SelectItem>
                <SelectItem value="system">{t("System journal")}</SelectItem>
                <SelectItem value="caddy">Caddy</SelectItem>
                <SelectItem value="ssh">SSH</SelectItem>
                <SelectItem value="php">PHP-FPM</SelectItem>
                <SelectItem value="apps">{t("App units")}</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              onClick={() => refetchLogs()}
              disabled={logsLoading}
            >
              {logsLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              {t("Refresh")}
            </Button>
          </div>

          {/* the journal is wide; it scrolls inside its own box rather than
              stretching the dialog */}
          <pre className="max-h-[55vh] overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
            {logsLoading && !logs ? t("Loading…") : logs?.output || t("(no output)")}
          </pre>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmSetup} onOpenChange={(o) => !o && setConfirmSetup(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Set up {name}?", { name: confirmSetup?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("Runs install.sh as root on this box over SSH: system packages, Caddy, the panel's SSH user with passwordless root, and the panel's key. Takes a few minutes. Safe to re-run.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={withPhp} onCheckedChange={(v) => setWithPhp(v === true)} />
            {t("Also install PHP-FPM and Composer")}
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmSetup && setupMutation.mutate(confirmSetup)}>
              {t("Set up server")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!setupLogFor} onOpenChange={(o) => !o && setSetupLogFor(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {t("Setup output — {name}", { name: setupLogServer?.name ?? "" })}
              {setupLogServer && <ProvisionBadge state={setupLogServer.setupState} />}
            </DialogTitle>
            {setupLogServer?.setupError && (
              <DialogDescription className="text-destructive">{setupLogServer.setupError}</DialogDescription>
            )}
          </DialogHeader>
          <pre ref={setupLogRef} className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
            {setupLogServer?.setupLog ||
              (setupLogServer?.setupState === "QUEUED" ? t("Waiting to start…") : t("Waiting for output…"))}
          </pre>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Delete {name}?", { name: confirmDelete?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("Only removes the node from the panel — nothing on the box is touched. A node with organizations placed on it cannot be deleted.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDelete && deleteMutation.mutate(confirmDelete)}
            >
              {t("Delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageLayout>
  );
}
