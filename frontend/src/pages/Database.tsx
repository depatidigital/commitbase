import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertCircle,
  Copy,
  Database as DatabaseIcon,
  Eye,
  EyeOff,
  FileUp,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { OrganizationFilter } from "@/components/OrganizationFilter";
import { OrganizationCombobox } from "@/components/OrganizationCombobox";
import { DatabaseImportDialog } from "@/components/DatabaseImportDialog";
import { useToast } from "@/hooks/use-toast";
import { isAdmin } from "@/lib/auth";
import {
  type CreateDatabaseData,
  type DatabaseWithApplication,
  createDatabase,
  deleteDatabase,
  getAllDatabases,
  getDatabaseCredentials,
  provisionDatabase,
} from "@/lib/databases";
import { getOrganization } from "@/lib/organizations";
import { locale, t } from "@/lib/i18n";

const STATUS_DOT: Record<string, string> = {
  RUNNING: "bg-success",
  CREATING: "bg-warning",
  STOPPED: "bg-muted-foreground",
  ERROR: "bg-destructive",
};

const STATUS_LABEL: Record<string, string> = {
  RUNNING: t("Running"),
  CREATING: t("Creating"),
  STOPPED: t("Stopped"),
  ERROR: t("Error"),
};

const ENGINE_LABEL: Record<string, string> = { POSTGRESQL: "PostgreSQL", MYSQL: "MySQL" };

const NAME_RE = /^[a-z][a-z0-9_]{0,40}$/;

const size = (bytes?: number | null) => {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString(locale, { maximumFractionDigits: unit < 2 ? 0 : 1 })} ${units[unit]}`;
};

const BLANK: CreateDatabaseData = { name: "", type: "POSTGRESQL" };

export default function Database() {
  const query = useTableQuery();
  const admin = isAdmin();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<CreateDatabaseData>(BLANK);
  const [credentialsFor, setCredentialsFor] = useState<DatabaseWithApplication | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [deleting, setDeleting] = useState<DatabaseWithApplication | null>(null);
  const [importing, setImporting] = useState<DatabaseWithApplication | null>(null);
  const [confirmName, setConfirmName] = useState("");

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ["databases", query.params],
    queryFn: () => getAllDatabases(query.params),
  });

  // the chosen org's slug, for the real-name preview
  const { data: chosenOrg } = useQuery({
    queryKey: ["organizations", form.organizationId],
    queryFn: () => getOrganization(form.organizationId as string),
    enabled: creating && !!form.organizationId,
  });

  const { data: credentials, isFetching: credentialsLoading, error: credentialsError } = useQuery({
    queryKey: ["databases", credentialsFor?.id, "credentials"],
    queryFn: () => getDatabaseCredentials(credentialsFor!.id),
    enabled: !!credentialsFor,
    // a password is read on purpose, each time — and each read is audited
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["databases"] });
  const fail = (error: Error) => toast({ title: t("Error"), description: error.message, variant: "destructive" });

  const createMutation = useMutation({
    mutationFn: () => createDatabase(form),
    onSuccess: (database) => {
      refresh();
      setCreating(false);
      setForm(BLANK);
      toast({ title: t("Database {name} created", { name: database.dbName ?? database.name }) });
    },
    onError: (error: Error) => {
      // the row may exist in ERROR state even though the call failed
      refresh();
      fail(error);
    },
  });

  const retryMutation = useMutation({
    mutationFn: (db: DatabaseWithApplication) => provisionDatabase(db.id),
    onSuccess: () => {
      refresh();
      toast({ title: t("Database is ready") });
    },
    onError: (error: Error) => {
      refresh();
      fail(error);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (db: DatabaseWithApplication) => deleteDatabase(db.id, confirmName || undefined),
    onSuccess: (_, db) => {
      refresh();
      setDeleting(null);
      setConfirmName("");
      toast({ title: db.discovered ? t("Removed from the panel") : t("Database deleted") });
    },
    onError: fail,
  });

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    toast({ title: t("Copied") });
  };

  const columns: Column<DatabaseWithApplication>[] = [
    {
      header: t("Name"),
      className: "w-[22%]",
      cell: (db) => (
        <div className="min-w-0">
          <span className="block truncate font-medium">{db.name}</span>
          {db.dbName && db.dbName !== db.name && (
            <span className="block truncate font-mono text-xs text-muted-foreground">{db.dbName}</span>
          )}
        </div>
      ),
    },
    {
      header: t("Type"),
      className: "w-28",
      cell: (db) => <Badge variant="secondary">{ENGINE_LABEL[db.type] ?? db.type}</Badge>,
    },
    {
      header: t("Status"),
      className: "w-40",
      cell: (db) => (
        <div className="min-w-0">
          <div className="flex items-center space-x-2">
            <div className={`h-2 w-2 rounded-full ${STATUS_DOT[db.status] ?? "bg-muted-foreground"}`} />
            <span>{STATUS_LABEL[db.status] ?? db.status}</span>
          </div>
          {db.lastError && (
            <span className="block truncate text-xs text-destructive" title={db.lastError}>
              {db.lastError}
            </span>
          )}
        </div>
      ),
    },
    ...(admin
      ? [
          {
            header: t("Organization"),
            className: "w-[18%]",
            cell: (db: DatabaseWithApplication) => {
              const organization = db.organization ?? db.application?.organization;
              return organization ? (
                <Badge variant="outline" className="max-w-full truncate">
                  {organization.name}
                </Badge>
              ) : (
                <span className="text-muted-foreground">{t("Unassigned")}</span>
              );
            },
          },
          {
            header: t("Server"),
            className: "w-32 text-xs",
            cell: (db: DatabaseWithApplication) =>
              db.databaseServer ? (
                <Link to={`/database-servers/${db.databaseServer.id}`} className="block truncate hover:underline">
                  {db.databaseServer.name}
                </Link>
              ) : (
                <span className="text-muted-foreground">—</span>
              ),
          },
        ]
      : []),
    {
      header: t("App"),
      className: "w-[16%]",
      cell: (db) =>
        db.application ? (
          <Link to={`/application/${db.application.id}`} className="block truncate text-primary hover:underline">
            {db.application.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    { header: t("Size"), className: "w-24 text-xs", cell: (db) => size(db.sizeBytes) },
    {
      header: t("Created"),
      className: "w-28 text-xs",
      cell: (db) => new Date(db.createdAt).toLocaleDateString(locale),
    },
    {
      header: "",
      className: "w-16 text-right",
      cell: (db) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label={t("Actions for {name}", { name: db.name })}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {!db.discovered && db.status === "RUNNING" && (
              <DropdownMenuItem
                onClick={() => {
                  setShowPassword(false);
                  setCredentialsFor(db);
                }}
              >
                <KeyRound className="mr-2 h-4 w-4" />
                {t("Credentials")}
              </DropdownMenuItem>
            )}
            {!db.discovered && db.status === "RUNNING" && (
              <DropdownMenuItem onClick={() => setImporting(db)}>
                <FileUp className="mr-2 h-4 w-4" />
                {t("Restore DB (.sql)")}
              </DropdownMenuItem>
            )}
            {!db.discovered && db.status !== "RUNNING" && (
              <DropdownMenuItem disabled={retryMutation.isPending} onClick={() => retryMutation.mutate(db)}>
                <RotateCcw className="mr-2 h-4 w-4" />
                {t("Retry")}
              </DropdownMenuItem>
            )}
            {(!db.discovered || admin) && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => {
                    setConfirmName("");
                    setDeleting(db);
                  }}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {db.discovered ? t("Remove from panel") : t("Delete")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  if (error) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-center">
          <AlertCircle className="mx-auto mb-4 h-12 w-12 text-destructive" />
          <h3 className="mb-2 text-lg font-semibold">{t("Error loading databases")}</h3>
          <p className="mb-4 text-muted-foreground">{(error as Error).message}</p>
          <Button variant="outline" onClick={() => refetch()}>
            {t("Try again")}
          </Button>
        </div>
      </div>
    );
  }

  const nameValid = NAME_RE.test(form.name);
  const preview = chosenOrg && nameValid ? `${chosenOrg.slug.replace(/-/g, "_")}_${form.name}` : null;

  return (
    <PageLayout
      icon={DatabaseIcon}
      title={t("Databases")}
      description={t("Databases provisioned for your applications.")}
      actions={
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-2 h-4 w-4" /> {t("Create database")}
        </Button>
      }
    >
      <DataTable
        columns={columns}
        rows={data?.data ?? []}
        rowKey={(db) => db.id}
        query={query}
        pagination={data?.pagination}
        isLoading={isFetching}
        searchPlaceholder={t("Search name or application…")}
        toolbar={<OrganizationFilter query={query} />}
        empty={t("No databases yet.")}
      />

      {/* create */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-md">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              createMutation.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("Create database")}</DialogTitle>
              <DialogDescription>
                {t("Created on the organization's database server and owned by its own login there — nobody else can connect to it.")}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>{t("Organization")}</Label>
                <OrganizationCombobox
                  value={form.organizationId ?? null}
                  onChange={(id) => setForm({ ...form, organizationId: id ?? undefined })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="db-engine">{t("Engine")}</Label>
                <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v as CreateDatabaseData["type"] })}>
                  <SelectTrigger id="db-engine">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="POSTGRESQL">PostgreSQL</SelectItem>
                    <SelectItem value="MYSQL">MySQL</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="db-name">{t("Name")}</Label>
                <Input
                  id="db-name"
                  autoComplete="off"
                  placeholder="crm"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase() })}
                />
                <p className={`text-xs ${form.name && !nameValid ? "text-destructive" : "text-muted-foreground"}`}>
                  {form.name && !nameValid
                    ? t("Lowercase letters, digits and underscores, starting with a letter.")
                    : preview
                      ? t("Created on the server as {name}", { name: preview })
                      : t("The organization's name is added in front, so tenants never collide.")}
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button type="submit" disabled={!form.organizationId || !nameValid || createMutation.isPending}>
                {createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t("Create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* credentials */}
      <Dialog open={!!credentialsFor} onOpenChange={(open) => !open && setCredentialsFor(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("Credentials for {name}", { name: credentialsFor?.dbName ?? credentialsFor?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("Viewing these is recorded in the audit log.")}</DialogDescription>
          </DialogHeader>
          {credentialsLoading ? (
            <Loader2 className="mx-auto my-6 h-5 w-5 animate-spin" />
          ) : credentialsError ? (
            <p className="text-sm text-destructive">{(credentialsError as Error).message}</p>
          ) : credentials ? (
            <div className="space-y-3 text-sm">
              {(
                [
                  [t("Host"), credentials.host],
                  [t("Port"), String(credentials.port)],
                  [t("Database"), credentials.database],
                  [t("Username"), credentials.username],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
                  <code className="min-w-0 flex-1 truncate">{value}</code>
                  <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => copy(value)} aria-label={t("Copy")}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-muted-foreground">{t("Password")}</span>
                <code className="min-w-0 flex-1 truncate">{showPassword ? credentials.password : "••••••••••••"}</code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? t("Hide") : t("Show")}
                >
                  {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
                <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => copy(credentials.password)} aria-label={t("Copy")}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="space-y-1 pt-2">
                <span className="text-muted-foreground">{t("Connection URL")}</span>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
                    {showPassword ? credentials.url : credentials.url.replace(/:[^:@/]+@/, ":••••@")}
                  </code>
                  <Button type="button" variant="outline" size="sm" onClick={() => copy(credentials.url)}>
                    <Copy className="mr-1.5 h-3.5 w-3.5" /> {t("Copy")}
                  </Button>
                </div>
              </div>
              {credentials.tls && (
                <p className="text-xs text-muted-foreground">{t("This server is reached over the network — connect with TLS.")}</p>
              )}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <DatabaseImportDialog
        database={importing && { ...importing, organization: importing.organization ?? importing.application?.organization }}
        onClose={() => setImporting(null)}
      />

      {/* delete */}
      <Dialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {deleting?.discovered
                ? t("Remove {name} from the panel?", { name: deleting.dbName ?? deleting.name })
                : t("Delete {name}?", { name: deleting?.dbName ?? deleting?.name ?? "" })}
            </DialogTitle>
            <DialogDescription>
              {deleting?.discovered
                ? t("It was imported from its server and stays there untouched. The next sync lists it again, unassigned.")
                : t("The database and all its data are dropped on the server. This cannot be undone.")}
            </DialogDescription>
          </DialogHeader>
          {!deleting?.discovered && deleting?.dbName && (
            <div className="space-y-2">
              <Label htmlFor="db-confirm">{t("Type {name} to confirm", { name: deleting.dbName })}</Label>
              <Input id="db-confirm" autoComplete="off" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              {t("Cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={
                deleteMutation.isPending || (!deleting?.discovered && !!deleting?.dbName && confirmName !== deleting.dbName)
              }
              onClick={() => deleting && deleteMutation.mutate(deleting)}
            >
              {deleteMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {deleting?.discovered ? t("Remove") : t("Delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageLayout>
  );
}
