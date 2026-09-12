import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Database, Eye, Loader2, MoreHorizontal, Pencil, Plus, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { t } from "@/lib/i18n";
import { getServers } from "@/lib/servers";
import {
  DEFAULT_PORT,
  ENGINE_LABEL,
  type DatabaseServer,
  type DatabaseServerInput,
  type DbEngine,
  createDatabaseServer,
  deleteDatabaseServer,
  getDatabaseServersPage,
  testDatabaseServer,
  updateDatabaseServer,
} from "@/lib/databaseServers";

const BLANK: DatabaseServerInput = {
  name: "",
  engine: "POSTGRESQL",
  mode: "TUNNEL",
  serverId: null,
  host: "127.0.0.1",
  port: DEFAULT_PORT.POSTGRESQL,
  // through a tunnel the SSH connection already encrypts; a direct server gets REQUIRE
  tlsMode: "DISABLE",
  caCert: "",
  adminUser: "",
  adminPassword: "",
  appHost: "127.0.0.1",
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  ONLINE: "default",
  OFFLINE: "destructive",
  UNKNOWN: "secondary",
};

const STATUS_LABEL: Record<string, string> = {
  ONLINE: t("Online"),
  OFFLINE: t("Offline"),
  UNKNOWN: t("Unknown"),
};

export default function DatabaseServers() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const query = useTableQuery();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<DatabaseServer | null>(null);
  const [form, setForm] = useState<DatabaseServerInput>(BLANK);
  const [confirmDelete, setConfirmDelete] = useState<DatabaseServer | null>(null);

  const { data, isFetching } = useQuery({
    queryKey: ["database-servers", "page", query.params],
    queryFn: () => getDatabaseServersPage(query.params),
  });
  const { data: nodes = [] } = useQuery({ queryKey: ["servers"], queryFn: getServers });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["database-servers"] });
  const fail = (error: Error) => toast({ title: t("Error"), description: error.message, variant: "destructive" });

  const openNew = () => {
    setEditing(null);
    setForm(BLANK);
    setOpen(true);
  };

  const openEdit = (row: DatabaseServer) => {
    setEditing(row);
    setForm({
      name: row.name,
      engine: row.engine,
      mode: row.mode,
      serverId: row.serverId,
      host: row.host,
      port: row.port,
      tlsMode: row.tlsMode,
      caCert: row.caCert ?? "",
      adminUser: row.adminUser,
      // never prefilled: blank keeps the stored password
      adminPassword: "",
      appHost: row.appHost,
    });
    setOpen(true);
  };

  /** Switching mode resets TLS to the sensible default for it. */
  const setMode = (mode: DatabaseServerInput["mode"]) =>
    setForm({ ...form, mode, tlsMode: mode === "TUNNEL" ? "DISABLE" : "REQUIRE", serverId: mode === "TUNNEL" ? form.serverId : null });

  const setEngine = (engine: DbEngine) =>
    // keep a port the operator typed; swap only the other engine's default
    setForm({ ...form, engine, port: form.port === DEFAULT_PORT[form.engine] ? DEFAULT_PORT[engine] : form.port });

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload: DatabaseServerInput = {
        ...form,
        serverId: form.mode === "TUNNEL" ? form.serverId : null,
        caCert: form.tlsMode === "VERIFY" && form.caCert?.trim() ? form.caCert : null,
        adminPassword: form.adminPassword || undefined,
      };
      if (!editing) return createDatabaseServer(payload);
      // the engine is fixed once databases can exist on it
      const { engine: _engine, ...patch } = payload;
      return updateDatabaseServer(editing.id, patch);
    },
    onSuccess: ({ server, message }) => {
      refresh();
      setOpen(false);
      toast({
        title: editing ? t("Database server updated") : t("Database server registered"),
        description: message,
        variant: server?.status === "ONLINE" ? undefined : "destructive",
      });
    },
    onError: fail,
  });

  const testMutation = useMutation({
    mutationFn: (row: DatabaseServer) => testDatabaseServer(row.id).then((result) => ({ ...result, row })),
    onSuccess: ({ ok, message, row }) => {
      refresh();
      toast({
        title: ok ? t("{name} is online", { name: row.name }) : t("{name} could not be reached", { name: row.name }),
        description: message,
        variant: ok ? undefined : "destructive",
      });
    },
    onError: fail,
  });

  const deleteMutation = useMutation({
    mutationFn: (row: DatabaseServer) => deleteDatabaseServer(row.id),
    onSuccess: () => {
      refresh();
      setConfirmDelete(null);
      toast({ title: t("Database server removed") });
    },
    onError: (error: Error) => {
      setConfirmDelete(null);
      fail(error);
    },
  });

  const columns: Column<DatabaseServer>[] = [
    {
      header: t("Name"),
      className: "w-[20%]",
      cell: (row) => (
        <div className="min-w-0">
          <Link to={`/database-servers/${row.id}`} className="block truncate font-medium hover:underline">
            {row.name}
          </Link>
          <span className="block truncate text-xs text-muted-foreground">
            {row.version ?? ENGINE_LABEL[row.engine]}
          </span>
        </div>
      ),
    },
    {
      header: t("Connection"),
      className: "w-[26%]",
      cell: (row) => (
        <div className="min-w-0 text-xs">
          <span className="block truncate font-mono">
            {row.adminUser}@{row.host}:{row.port}
          </span>
          <span className="block truncate text-muted-foreground">
            {row.mode === "TUNNEL" ? (
              <>
                {t("Tunnel via")}{" "}
                {row.server ? (
                  <Link to={`/servers/${row.server.id}`} className="hover:underline">
                    {row.server.name}
                  </Link>
                ) : (
                  "—"
                )}
              </>
            ) : (
              t("Direct · TLS {mode}", { mode: row.tlsMode.toLowerCase() })
            )}
          </span>
        </div>
      ),
    },
    {
      header: t("Status"),
      className: "w-36",
      cell: (row) => {
        // an admin with everything is reachable and working, and still a risk worth seeing
        const superuser = row.adminRights?.split(",").includes("superuser");
        return (
          <div className="space-y-1">
            <Badge variant={STATUS_VARIANT[row.status] ?? "secondary"}>{STATUS_LABEL[row.status] ?? row.status}</Badge>
            {superuser && (
              <Badge
                variant="outline"
                className="gap-1 border-warning/40 text-xs text-warning"
                title={t("The admin login is a superuser. Prefer a login with only CREATEROLE and CREATEDB (Postgres) or CREATE USER, CREATE, DROP and GRANT OPTION (MySQL).")}
              >
                <ShieldAlert className="h-3 w-3" />
                {t("superuser")}
              </Badge>
            )}
          </div>
        );
      },
    },
    {
      header: t("Orgs"),
      className: "w-20",
      cell: (row) => row._count.postgresOrgs + row._count.mysqlOrgs,
    },
    { header: t("Databases"), className: "w-24", cell: (row) => row._count.databases },
    {
      header: t("Last error"),
      className: "w-[22%]",
      cell: (row) =>
        row.lastError ? (
          <span className="block truncate text-xs text-destructive" title={row.lastError}>
            {row.lastError}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      header: "",
      className: "w-16 text-right",
      cell: (row) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label={t("Actions for {name}", { name: row.name })}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => navigate(`/database-servers/${row.id}`)}>
              <Eye className="mr-2 h-4 w-4" />
              {t("Databases and logins")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={testMutation.isPending} onClick={() => testMutation.mutate(row)}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {t("Test connection")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openEdit(row)}>
              <Pencil className="mr-2 h-4 w-4" />
              {t("Edit")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setConfirmDelete(row)}>
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
    !form.host.trim() ||
    !form.adminUser.trim() ||
    !form.appHost.trim() ||
    (form.mode === "TUNNEL" && !form.serverId) ||
    (!form.adminPassword?.trim() && !editing?.hasPassword);

  return (
    <PageLayout
      icon={Database}
      title={t("Database Servers")}
      description={t("PostgreSQL and MySQL servers tenant databases are created on. Organizations are placed on one per engine from their organization page.")}
      actions={
        <Button onClick={openNew}>
          <Plus className="mr-2 h-4 w-4" /> {t("Add database server")}
        </Button>
      }
    >
      <DataTable
        columns={columns}
        rows={data?.data ?? []}
        rowKey={(row) => row.id}
        query={query}
        pagination={data?.pagination}
        isLoading={isFetching}
        searchPlaceholder={t("Search name or host…")}
        empty={t("No database servers yet.")}
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveMutation.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>{editing ? t("Edit {name}", { name: editing.name }) : t("Add database server")}</DialogTitle>
              <DialogDescription>
                {form.mode === "TUNNEL"
                  ? t("The engine runs on one of our nodes and listens only on its loopback or private address. The control plane reaches it through that node's SSH connection — no database port is public.")
                  : t("A managed service reached directly over the network, so always over TLS.")}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 py-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="dbs-name">{t("Name")}</Label>
                <Input
                  id="dbs-name"
                  autoFocus
                  placeholder="pg-node-1"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="dbs-engine">{t("Engine")}</Label>
                <Select value={form.engine} onValueChange={(v) => setEngine(v as DbEngine)} disabled={!!editing}>
                  <SelectTrigger id="dbs-engine">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="POSTGRESQL">PostgreSQL</SelectItem>
                    <SelectItem value="MYSQL">MySQL / MariaDB</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="dbs-mode">{t("Where it runs")}</Label>
                <Select value={form.mode} onValueChange={(v) => setMode(v as DatabaseServerInput["mode"])}>
                  <SelectTrigger id="dbs-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TUNNEL">{t("On one of our nodes (SSH tunnel)")}</SelectItem>
                    <SelectItem value="DIRECT">{t("Managed service (direct, TLS)")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.mode === "TUNNEL" ? (
                <div className="space-y-2">
                  <Label htmlFor="dbs-node">{t("Node")}</Label>
                  <Select value={form.serverId ?? ""} onValueChange={(v) => setForm({ ...form, serverId: v })}>
                    <SelectTrigger id="dbs-node">
                      <SelectValue placeholder={t("Choose a node…")} />
                    </SelectTrigger>
                    <SelectContent>
                      {nodes.map((node) => (
                        <SelectItem key={node.id} value={node.id}>
                          {node.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="dbs-tls">{t("TLS")}</Label>
                  <Select
                    value={form.tlsMode}
                    onValueChange={(v) => setForm({ ...form, tlsMode: v as DatabaseServerInput["tlsMode"] })}
                  >
                    <SelectTrigger id="dbs-tls">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="REQUIRE">{t("Required (encrypted, certificate not checked)")}</SelectItem>
                      <SelectItem value="VERIFY">{t("Verify certificate")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="grid grid-cols-[1fr_100px] gap-2 sm:col-span-2">
                <div className="space-y-2">
                  <Label htmlFor="dbs-host">{t("Host")}</Label>
                  <Input
                    id="dbs-host"
                    placeholder={form.mode === "TUNNEL" ? "127.0.0.1" : "db.example.com"}
                    value={form.host}
                    onChange={(e) => setForm({ ...form, host: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="dbs-port">{t("Port")}</Label>
                  <Input
                    id="dbs-port"
                    type="number"
                    value={form.port}
                    onChange={(e) => setForm({ ...form, port: Number(e.target.value) || DEFAULT_PORT[form.engine] })}
                  />
                </div>
                <p className="col-span-2 text-xs text-muted-foreground">
                  {form.mode === "TUNNEL"
                    ? t("As seen from the node — usually 127.0.0.1.")
                    : t("The address the control plane connects to.")}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="dbs-admin">{t("Admin user")}</Label>
                <Input
                  id="dbs-admin"
                  autoComplete="off"
                  placeholder={form.engine === "POSTGRESQL" ? "larika_admin" : "cb_admin"}
                  value={form.adminUser}
                  onChange={(e) => setForm({ ...form, adminUser: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="dbs-password">{t("Admin password")}</Label>
                <Input
                  id="dbs-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder={editing?.hasPassword ? t("Unchanged — type to replace") : ""}
                  value={form.adminPassword ?? ""}
                  onChange={(e) => setForm({ ...form, adminPassword: e.target.value })}
                />
              </div>
              <p className="-mt-2 text-xs text-muted-foreground sm:col-span-2">
                {form.engine === "POSTGRESQL"
                  ? t("Give it CREATEROLE and CREATEDB — not superuser. Encrypted before it is stored and never returned by the API.")
                  : t("Give it CREATE USER, CREATE and DROP on *.* WITH GRANT OPTION — not root. Encrypted before it is stored and never returned by the API.")}
              </p>

              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="dbs-apphost">{t("Host apps connect to")}</Label>
                <Input
                  id="dbs-apphost"
                  placeholder={form.mode === "TUNNEL" ? "10.0.0.5" : "db.example.com"}
                  value={form.appHost}
                  onChange={(e) => setForm({ ...form, appHost: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  {t("Goes into the apps' connection string: localhost when they run on the same node, its private IP otherwise.")}
                </p>
              </div>

              {form.mode === "DIRECT" && form.tlsMode === "VERIFY" && (
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="dbs-ca">{t("CA certificate (optional)")}</Label>
                  <Textarea
                    id="dbs-ca"
                    rows={4}
                    className="font-mono text-xs"
                    placeholder="-----BEGIN CERTIFICATE-----"
                    value={form.caCert ?? ""}
                    onChange={(e) => setForm({ ...form, caCert: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("PEM. Leave empty to verify against the system's trusted roots.")}
                  </p>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button type="submit" disabled={incomplete || saveMutation.isPending}>
                {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {editing ? t("Save") : t("Add and test")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Remove {name}?", { name: confirmDelete?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("This only removes it from the panel — nothing on the server is touched. It is refused while organizations or databases still use it.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => confirmDelete && deleteMutation.mutate(confirmDelete)}
            >
              {t("Remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageLayout>
  );
}
