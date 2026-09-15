import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Database as DatabaseIcon, Loader2, PlugZap, Search, Star, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  type DatabaseServerChoice,
  type LoginChoice,
  attachDatabase,
  createDatabase,
  getAllDatabases,
  getDatabaseLogins,
  getDatabaseServerChoices,
  getProjectDatabases,
  testDatabaseUrl,
} from "@/lib/databases";
import { parseDatabaseUrl, toDbName } from "@/lib/env";
import { t } from "@/lib/i18n";

interface DatabaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `sourceId`: its project — a database another app of it uses is offered first */
  application: { id: string; name: string; organizationId?: string | null; sourceId?: string | null };
  /** DATABASE_URL as it stands — its engine and name prefill the form */
  currentUrl?: string;
  /** the app's other database variables, filled from the same credentials */
  alsoKeys?: string[];
  /** after the values are in the app's env — the names that were written */
  onConnected: (keys: string[]) => void;
  /** "Custom": the URL typed — put in the form (saved with it), not written by this dialog */
  onCustom: (url: string) => void;
}

/** a database name from the app's hostname: `shop.acme.id` → `shop` */
const nameFrom = (domain: string) => toDbName(domain.split(".")[0] || "app");

const ENGINE = { POSTGRESQL: "PostgreSQL", MYSQL: "MySQL" } as const;

/** `pg-db-1 · PostgreSQL 16` — the major version is what matters, not the distro's build string */
const serverLabel = (server: DatabaseServerChoice) => {
  const major = server.version?.match(/(\d+)/)?.[1];
  return `${server.name} · ${ENGINE[server.engine]}${major ? ` ${major}` : ""}`;
};

/** A small two-way switch — "create / existing", "new login / existing". */
function Choice<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-md border border-border/60 p-0.5 text-sm" role="group">
      {options.map(([option, label]) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={`rounded px-3 py-1 transition-colors ${
            value === option ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * Give an app a database: a new one on a server of your choice, or one the
 * organization already has — a database another app of its project uses comes
 * first, picked when there is one. Every app connects as the organization's one
 * login on that server (org_<slug>). What will be written is summed up before
 * Connect. Its URL lands in the app's env server-side (DATABASE_URL); the
 * password never reaches this page.
 */
export function DatabaseDialog({ open, onOpenChange, application, currentUrl, alsoKeys = [], onConnected, onCustom }: DatabaseDialogProps) {
  const { toast } = useToast();
  const orgId = application.organizationId ?? "";
  // where the value comes from: one of the organization's databases, or a URL of its own
  const [source, setSource] = useState<"ours" | "custom">("ours");
  const [customUrl, setCustomUrl] = useState("");
  const [customCheck, setCustomCheck] = useState<"pending" | { ok: boolean; message: string } | null>(null);
  const [mode, setMode] = useState<"create" | "existing">("create");
  const [name, setName] = useState(() => nameFrom(application.name));
  const [serverId, setServerId] = useState("");
  const [existingId, setExistingId] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const fromUrl = parseDatabaseUrl(currentUrl);
  // the name every ORM and driver reads by default; the app's code fixes it, not this dialog
  const envKey = "DATABASE_URL";

  // each opening starts from what DATABASE_URL says, else from the hostname
  useEffect(() => {
    if (!open) return;
    setSource("ours");
    setCustomUrl(currentUrl ?? "");
    setCustomCheck(null);
    setMode("create");
    setExistingId("");
    setServerId("");
    setSearch("");
    setName(fromUrl.name || nameFrom(application.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const servers = useQuery({
    queryKey: ["databases", "servers", orgId],
    queryFn: () => getDatabaseServerChoices(orgId),
    enabled: open,
  });
  // the org's own server for the URL's engine, else its other one, else any
  useEffect(() => {
    if (!open || serverId || !servers.data?.length) return;
    const list = servers.data;
    const pick =
      list.find((s) => s.default && s.engine === (fromUrl.engine || "POSTGRESQL")) ??
      list.find((s) => s.default) ??
      list.find((s) => s.engine === fromUrl.engine) ??
      list[0];
    if (pick) setServerId(pick.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, servers.data]);

  const existing = useQuery({
    queryKey: ["databases", "org", orgId],
    queryFn: () => getAllDatabases({ page: 1, limit: 100, search: "", organizationId: orgId || undefined }),
    enabled: open && !!orgId,
  });
  // the project's databases, and which of its apps use each — the monorepo's shared one comes first
  const projectDbs = useQuery({
    queryKey: ["databases", "project", application.sourceId],
    queryFn: () => getProjectDatabases(application.sourceId!),
    enabled: open && !!application.sourceId,
  });
  const siblingsOf = (dbId: string) =>
    (projectDbs.data?.find((db) => db.id === dbId)?.usedBy ?? []).filter((app) => app.id !== application.id);
  const choices = useMemo(
    () =>
      (existing.data?.data ?? [])
        .filter((db) => db.type === "POSTGRESQL" || db.type === "MYSQL")
        // used by another app of this project first, then by name
        .sort(
          (a, b) =>
            Number(siblingsOf(b.id).length > 0) - Number(siblingsOf(a.id).length > 0) ||
            (a.dbName || a.name).localeCompare(b.dbName || b.name),
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [existing.data, projectDbs.data],
  );
  const shown = choices.filter((db) => !search.trim() || (db.dbName || db.name).toLowerCase().includes(search.trim().toLowerCase()));
  const chosen = choices.find((db) => db.id === existingId);

  // Where to start: the database the URL names, when it is one of ours (the panel's,
  // not one found on a server); a URL of anything else is a custom one, shown as such;
  // with none, the one another app of the project uses — a monorepo's apps share one —
  // else a new one. (A project's list that failed to load does not hold this up.)
  useEffect(() => {
    if (!open || existingId || !existing.data || (application.sourceId && projectDbs.isLoading)) return;
    const named = fromUrl.name
      ? choices.find((db) => !db.discovered && (db.dbName === fromUrl.name || db.name === fromUrl.name))
      : undefined;
    if (currentUrl?.trim() && !named) {
      setSource("custom");
      return;
    }
    const pick = named ?? choices.find((db) => siblingsOf(db.id).length > 0);
    if (pick) {
      setMode("existing");
      setExistingId(pick.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing.data, projectDbs.data, projectDbs.isLoading]);

  // One login per organization on each server — org_<slug>, made the first time it is
  // needed — reaches every database of the organization's apps. Nothing to choose.
  const loginServerId = mode === "create" ? serverId : chosen?.databaseServerId ?? "";
  const logins = useQuery({
    queryKey: ["databases", "logins", orgId, loginServerId],
    queryFn: () => getDatabaseLogins(orgId, loginServerId),
    enabled: open && !!orgId && !!loginServerId,
  });
  const prefix = logins.data?.prefix ?? "";
  // a name taken from a URL of ours already carries the org's prefix — it is added once, not twice
  useEffect(() => {
    if (prefix && name.startsWith(prefix)) setName(name.slice(prefix.length));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefix]);
  const orgLogin = logins.data?.logins.find((login) => login.username.startsWith("org_"))?.username ?? `org_${prefix.replace(/_+$/, "")}`;
  const customEngine = parseDatabaseUrl(customUrl).engine;
  const valid =
    source === "custom" ? !!customEngine : mode === "create" ? /^[a-z][a-z0-9_]{0,40}$/.test(name) && !!serverId : !!existingId;

  const server = servers.data?.find((s) => s.id === serverId);
  const summaryDb = mode === "create" ? `${prefix}${name}` : chosen?.dbName || chosen?.name || "";
  const summaryServer = mode === "create" ? server?.name : chosen?.databaseServer?.name;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    // a URL of its own: into the form, saved with the rest of the env
    if (source === "custom") {
      onCustom(customUrl.trim());
      onOpenChange(false);
      return;
    }
    setBusy(true);
    try {
      let databaseId = existingId;
      // no login given: the organization's own, on both ends
      let connectAs: LoginChoice | undefined;
      if (mode === "create") {
        const created = await createDatabase({ name, databaseServerId: serverId, applicationId: application.id });
        databaseId = created.id;
        // made with that login already — attach by id so it is not looked up twice
        if (created.accountId) connectAs = { accountId: created.accountId };
      }
      const { keys } = await attachDatabase(databaseId, application.id, envKey, alsoKeys, connectAs);
      toast({ title: t("Database connected"), description: t("{key} is set in the app's environment.", { key: keys.join(", ") }) });
      onConnected(keys);
      onOpenChange(false);
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Could not connect the database"),
        description: error instanceof Error ? error.message : "",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DatabaseIcon className="h-5 w-5 text-primary" />
            {t("Connect a database")}
          </DialogTitle>
          <DialogDescription>
            {t("Its connection URL is written to the app's environment. The password never leaves the server.")}
          </DialogDescription>
        </DialogHeader>

        <form id="database-connect" onSubmit={submit} className="space-y-4">
          {/* where the value comes from — the first choice, a tab each */}
          <div className="flex border-b border-border/60 text-sm" role="tablist">
            {(
              [
                ["ours", t("Larika database")],
                ["custom", t("Custom URL")],
              ] as const
            ).map(([option, label]) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={source === option}
                onClick={() => setSource(option)}
                className={`-mb-px border-b-2 px-3 py-2 transition-colors ${
                  source === option ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {source === "custom" ? (
            // a database the panel does not manage: its URL, tried from the app's node before it is used
            <div className="space-y-2">
              <Label htmlFor="custom-url">{t("Connection URL")}</Label>
              <Input
                id="custom-url"
                className="font-mono text-sm"
                placeholder="postgresql://user:password@host:5432/database"
                value={customUrl}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setCustomUrl(e.target.value);
                  setCustomCheck(null);
                }}
              />
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7"
                  disabled={!customEngine || customCheck === "pending"}
                  onClick={async () => {
                    setCustomCheck("pending");
                    setCustomCheck(
                      await testDatabaseUrl(application.id, envKey, customUrl.trim()).catch((error: Error) => ({ ok: false, message: error.message })),
                    );
                  }}
                >
                  {customCheck === "pending" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <PlugZap className="mr-1.5 h-3.5 w-3.5" />}
                  {t("Test connection")}
                </Button>
                {customCheck && customCheck !== "pending" && (
                  <span className={`flex min-w-0 items-center gap-1 break-all ${customCheck.ok ? "text-green-600 dark:text-green-400" : "text-destructive"}`}>
                    {customCheck.ok ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : <XCircle className="h-3.5 w-3.5 shrink-0" />}
                    {customCheck.message}
                  </span>
                )}
                {customUrl.trim() && !customEngine && <span className="text-destructive">{t("A postgresql:// or mysql:// URL.")}</span>}
              </div>
              <p className="text-xs text-muted-foreground">{t("Tried from the app's server. It goes in the form — saved with the rest of the environment.")}</p>
            </div>
          ) : (
          <>
          <Choice<"create" | "existing">
            value={mode}
            onChange={setMode}
            options={[
              ["create", t("Create new")],
              ["existing", t("Use existing")],
            ]}
          />

          {mode === "create" ? (
            // label column fixed, so the Login row below lines up with these
            <div className="grid gap-3 sm:grid-cols-[8.5rem_1fr] sm:items-center">
              <Label className="text-muted-foreground">{t("Database server")}</Label>
              {servers.isLoading ? (
                <p className="text-sm text-muted-foreground">{t("Loading…")}</p>
              ) : !servers.data?.length ? (
                <p className="text-sm text-muted-foreground">{t("No database server is online — ask a superadmin to add one.")}</p>
              ) : (
                <Select
                  value={serverId}
                  onValueChange={setServerId}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder={t("Choose a server")} />
                  </SelectTrigger>
                  <SelectContent>
                    {servers.data.map((s) => (
                      <SelectItem key={s.id} value={s.id} title={s.version ?? undefined}>
                        {serverLabel(s)}
                        {s.default && <span className="ml-2 text-xs text-muted-foreground">{t("organization default")}</span>}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Label htmlFor="db-name" className="text-muted-foreground">
                {t("Database name")}
              </Label>
              {/* the real name on the server carries the org's prefix, like the login */}
              <div>
                <div className="flex h-9 items-center rounded-md border border-input bg-card focus-within:ring-2 focus-within:ring-ring">
                  <span className="select-none pl-3 font-mono text-sm text-muted-foreground">{prefix}</span>
                  <input
                    id="db-name"
                    className="h-full min-w-0 flex-1 bg-transparent pr-3 font-mono text-sm outline-none"
                    value={name}
                    onChange={(e) => setName(e.target.value.toLowerCase())}
                  />
                </div>
                {/* the rule, only when it is broken */}
                {name && !/^[a-z][a-z0-9_]{0,40}$/.test(name) && (
                  <p className="mt-1 text-xs text-destructive">{t("Lowercase letters, digits and underscores.")}</p>
                )}
              </div>
            </div>
          ) : existing.isLoading ? (
            <p className="text-sm text-muted-foreground">{t("Loading…")}</p>
          ) : choices.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("This organization has no databases yet — create a new one.")}</p>
          ) : (
            // rows, searched — a dropdown hides which app uses what
            <div className="space-y-2">
              {choices.length > 5 && (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input className="h-9 pl-8" placeholder={t("Search databases…")} value={search} onChange={(e) => setSearch(e.target.value)} />
                </div>
              )}
              <ul className="max-h-56 divide-y divide-border/60 overflow-y-auto rounded-md border border-border/60" role="listbox">
                {shown.map((db) => {
                  const siblings = siblingsOf(db.id);
                  const selected = db.id === existingId;
                  return (
                    <li key={db.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => setExistingId(db.id)}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                          selected ? "bg-primary/10" : "hover:bg-muted/50"
                        }`}
                      >
                        <Star className={`h-3.5 w-3.5 shrink-0 ${siblings.length ? "fill-amber-400 text-amber-400" : "text-transparent"}`} />
                        <span className={`min-w-0 flex-1 truncate font-mono ${selected ? "font-medium text-primary" : ""}`}>{db.dbName || db.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {db.type === "POSTGRESQL" ? "PostgreSQL" : "MySQL"}
                          {siblings.length > 0
                            ? ` · ${t("used by {apps} (this project)", { apps: siblings.map((app) => app.name).join(", ") })}`
                            : db.application && db.application.id !== application.id
                              ? ` · ${t("used by {app}", { app: db.application.name })}`
                              : ""}
                        </span>
                      </button>
                    </li>
                  );
                })}
                {shown.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted-foreground">{t("No results.")}</li>}
              </ul>
            </div>
          )}

          {/* the login: the organization's one — said, not asked */}
          {loginServerId && (
            <div className="grid gap-3 sm:grid-cols-[8.5rem_1fr] sm:items-center">
              <Label className="text-muted-foreground">{t("Login")}</Label>
              <p className="font-mono text-sm">{orgLogin}</p>
            </div>
          )}

          {/* what Connect will do, read before it is done */}
          {loginServerId && summaryDb && (
            <div className="space-y-1 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("What will be written")}</p>
              <p>
                <code className="font-mono text-xs">{envKey}</code>
                {alsoKeys.length > 0 && <span className="text-xs text-muted-foreground"> + {alsoKeys.join(", ")}</span>}
                {" → "}
                <span className="font-mono">{summaryDb}</span>
                {summaryServer && <span className="text-muted-foreground"> · {summaryServer}</span>}
              </p>
              <p className="text-xs text-muted-foreground">{t("Connects as {login}.", { login: orgLogin })}</p>
            </div>
          )}
          </>
          )}
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button type="submit" form="database-connect" disabled={!valid || busy}>
            {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {source === "custom"
              ? t("Use this URL")
              : mode === "create"
                ? t("Create & connect")
                : chosen
                  ? t("Connect to {name}", { name: chosen.dbName || chosen.name })
                  : t("Connect")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
