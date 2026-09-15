import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Database as DatabaseIcon, Loader2, Search, Star } from "lucide-react";
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
}

/** a database name from the app's hostname: `shop.acme.id` → `shop` */
const nameFrom = (domain: string) => toDbName(domain.split(".")[0] || "app");

const ENGINE = { POSTGRESQL: "PostgreSQL", MYSQL: "MySQL" } as const;
const LOGIN_RE = /^[a-z][a-z0-9_]{0,30}$/;

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
 * first, picked when there is one. What will be written is summed up before
 * Connect; the login (a new one for this app, by default) is tucked in that
 * summary. Its URL lands in the app's env server-side (DATABASE_URL); the
 * password never reaches this page.
 */
export function DatabaseDialog({ open, onOpenChange, application, currentUrl, alsoKeys = [], onConnected }: DatabaseDialogProps) {
  const { toast } = useToast();
  const orgId = application.organizationId ?? "";
  const [mode, setMode] = useState<"create" | "existing">("create");
  const [name, setName] = useState(() => nameFrom(application.name));
  const [serverId, setServerId] = useState("");
  const [existingId, setExistingId] = useState("");
  const [search, setSearch] = useState("");
  // a login of its own per app by default: one app's credentials reach one database
  const [loginMode, setLoginMode] = useState<"new" | "existing">("new");
  const [loginName, setLoginName] = useState(() => nameFrom(application.name));
  const [accountId, setAccountId] = useState("");
  // the login is a detail: shown in the summary, opened with "Change"
  const [loginOpen, setLoginOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const fromUrl = parseDatabaseUrl(currentUrl);
  // the name every ORM and driver reads by default; the app's code fixes it, not this dialog
  const envKey = "DATABASE_URL";

  // each opening starts from what DATABASE_URL says, else from the hostname
  useEffect(() => {
    if (!open) return;
    setMode("create");
    setExistingId("");
    setServerId("");
    setSearch("");
    setName(fromUrl.name || nameFrom(application.name));
    setLoginMode("new");
    setLoginName(nameFrom(application.name));
    setAccountId("");
    setLoginOpen(false);
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

  // Where to start: the database the URL names (<org>_umojati or umojati), else the
  // one another app of the project uses — a monorepo's apps share one — else a new one
  useEffect(() => {
    if (!open || existingId || !existing.data || (application.sourceId && !projectDbs.data)) return;
    const named = fromUrl.name
      ? choices.find((db) => db.name === fromUrl.name || db.dbName === fromUrl.name || db.dbName?.endsWith(`_${fromUrl.name}`))
      : undefined;
    const shared = choices.find((db) => siblingsOf(db.id).length > 0);
    const pick = named ?? shared;
    if (pick) {
      setMode("existing");
      setExistingId(pick.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing.data, projectDbs.data]);

  // logins live on a server: the one chosen, or the chosen database's
  const loginServerId = mode === "create" ? serverId : chosen?.databaseServerId ?? "";
  const logins = useQuery({
    queryKey: ["databases", "logins", orgId, loginServerId],
    queryFn: () => getDatabaseLogins(orgId, loginServerId),
    enabled: open && !!orgId && !!loginServerId,
  });
  const loginList = logins.data?.logins ?? [];
  const prefix = logins.data?.prefix ?? "";
  // an existing database: the login that already reaches it is the obvious pick
  useEffect(() => {
    if (mode !== "existing" || !existingId || !logins.data) return;
    const reaching = loginList.find((login) => login.databases.some((db) => db.id === existingId));
    setLoginMode(reaching ? "existing" : "new");
    setAccountId(reaching?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, existingId, logins.data]);

  const login: LoginChoice | null =
    loginMode === "existing" ? (accountId ? { accountId } : null) : LOGIN_RE.test(loginName) ? { username: loginName } : null;
  const valid = !!login && (mode === "create" ? /^[a-z][a-z0-9_]{0,40}$/.test(name) && !!serverId : !!existingId);
  // an invalid login is not left hidden
  const loginShown = loginOpen || (!!loginServerId && !login);

  const server = servers.data?.find((s) => s.id === serverId);
  const summaryDb = mode === "create" ? `${prefix}${name}` : chosen?.dbName || chosen?.name || "";
  const summaryServer = mode === "create" ? server?.name : chosen?.databaseServer?.name;
  const summaryLogin =
    loginMode === "new"
      ? t("a new login {login}, for this database only", { login: `${prefix}${loginName}` })
      : t("the login {login}", { login: loginList.find((l) => l.id === accountId)?.username ?? "…" });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid || !login) return;
    setBusy(true);
    try {
      let databaseId = existingId;
      let connectAs: LoginChoice = login;
      if (mode === "create") {
        const created = await createDatabase({ name, databaseServerId: serverId, applicationId: application.id, login });
        databaseId = created.id;
        // made with that login already — attach by id so a new one is not made twice
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
          <Choice<"create" | "existing">
            value={mode}
            onChange={setMode}
            options={[
              ["create", t("Create new")],
              ["existing", t("Use existing")],
            ]}
          />

          {mode === "create" ? (
            <div className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-center">
              <Label className="text-muted-foreground">{t("Database server")}</Label>
              {servers.isLoading ? (
                <p className="text-sm text-muted-foreground">{t("Loading…")}</p>
              ) : !servers.data?.length ? (
                <p className="text-sm text-muted-foreground">{t("No database server is online — ask a superadmin to add one.")}</p>
              ) : (
                <Select
                  value={serverId}
                  onValueChange={(value) => {
                    setServerId(value);
                    setAccountId("");
                  }}
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
                <p className="mt-1 text-xs text-muted-foreground">{t("Lowercase letters, digits and underscores.")}</p>
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

          {/* what Connect will do — the login inside it, opened only to change it */}
          {loginServerId && summaryDb && (
            <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("What will be written")}</p>
              <p>
                <code className="font-mono text-xs">{envKey}</code>
                {alsoKeys.length > 0 && <span className="text-xs text-muted-foreground"> + {alsoKeys.join(", ")}</span>}
                {" → "}
                <span className="font-mono">{summaryDb}</span>
                {summaryServer && <span className="text-muted-foreground"> · {summaryServer}</span>}
              </p>
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span>{t("Connects as {login}.", { login: summaryLogin })}</span>
                <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={() => setLoginOpen((on) => !on)}>
                  {loginShown ? t("Hide") : t("Change")}
                </button>
              </p>

              {loginShown && (
                <div className="space-y-2 border-t border-primary/20 pt-2">
                  <Choice<"new" | "existing">
                    value={loginMode}
                    onChange={setLoginMode}
                    options={[
                      ["new", t("New login")],
                      ["existing", t("Existing login")],
                    ]}
                  />
                  {loginMode === "new" ? (
                    <div className="flex h-9 items-center rounded-md border border-input bg-card focus-within:ring-2 focus-within:ring-ring">
                      <span className="select-none pl-3 font-mono text-sm text-muted-foreground">{prefix}</span>
                      <input
                        aria-label={t("Login name")}
                        className="h-full min-w-0 flex-1 bg-transparent pr-3 font-mono text-sm outline-none"
                        value={loginName}
                        onChange={(e) => setLoginName(e.target.value.toLowerCase())}
                      />
                    </div>
                  ) : logins.isLoading ? (
                    <p className="text-sm text-muted-foreground">{t("Loading…")}</p>
                  ) : loginList.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("The organization has no logins on this server yet — make a new one.")}</p>
                  ) : (
                    <Select value={accountId} onValueChange={setAccountId}>
                      <SelectTrigger className="h-9 bg-card">
                        <SelectValue placeholder={t("Choose a login")} />
                      </SelectTrigger>
                      <SelectContent>
                        {loginList.map((account) => (
                          <SelectItem key={account.id} value={account.id}>
                            <span className="font-mono">{account.username}</span>
                            {" · "}
                            {account.databases.length === 1
                              ? t("reaches 1 database")
                              : t("reaches {count} databases", { count: account.databases.length })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}
            </div>
          )}
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button type="submit" form="database-connect" disabled={!valid || busy}>
            {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {mode === "create" ? t("Create & connect") : chosen ? t("Connect to {name}", { name: chosen.dbName || chosen.name }) : t("Connect")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
