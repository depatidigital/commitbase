import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Database as DatabaseIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  type LoginChoice,
  attachDatabase,
  createDatabase,
  getAllDatabases,
  getDatabaseLogins,
  getDatabaseServerChoices,
} from "@/lib/databases";
import { parseDatabaseUrl, toDbName } from "@/lib/env";
import { t } from "@/lib/i18n";

interface DatabaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  application: { id: string; domain: string; organizationId?: string | null };
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

/** Two-way switch drawn as buttons — used for "create / existing" and for the login. */
function Choice<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {options.map(([option, label]) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={`rounded-md border px-3 py-2 text-sm transition-colors ${
            value === option ? "border-primary bg-primary/5 font-medium text-primary" : "border-border/60 hover:border-primary/40"
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
 * organization already has — reached by a login the organization has or a new
 * one made for this app. Either way its URL lands in the app's env server-side
 * (DATABASE_URL by default); the password never reaches this page.
 */
export function DatabaseDialog({ open, onOpenChange, application, currentUrl, alsoKeys = [], onConnected }: DatabaseDialogProps) {
  const { toast } = useToast();
  const orgId = application.organizationId ?? "";
  const [mode, setMode] = useState<"create" | "existing">("create");
  const [name, setName] = useState(() => nameFrom(application.domain));
  const [serverId, setServerId] = useState("");
  const [existingId, setExistingId] = useState("");
  // a login of its own per app by default: one app's credentials reach one database
  const [loginMode, setLoginMode] = useState<"new" | "existing">("new");
  const [loginName, setLoginName] = useState(() => nameFrom(application.domain));
  const [accountId, setAccountId] = useState("");
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
    setName(fromUrl.name || nameFrom(application.domain));
    setLoginMode("new");
    setLoginName(nameFrom(application.domain));
    setAccountId("");
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
  const choices = (existing.data?.data ?? []).filter((db) => db.type === "POSTGRESQL" || db.type === "MYSQL");

  // the org already has the database the URL names (<org>_umojati or umojati): offer that one
  useEffect(() => {
    if (!open || !fromUrl.name || existingId) return;
    const match = choices.find(
      (db) => db.name === fromUrl.name || db.dbName === fromUrl.name || db.dbName?.endsWith(`_${fromUrl.name}`),
    );
    if (match) {
      setMode("existing");
      setExistingId(match.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing.data]);

  // logins live on a server: the one chosen, or the chosen database's
  const loginServerId = mode === "create" ? serverId : choices.find((db) => db.id === existingId)?.databaseServerId ?? "";
  const logins = useQuery({
    queryKey: ["databases", "logins", orgId, loginServerId],
    queryFn: () => getDatabaseLogins(orgId, loginServerId),
    enabled: open && !!orgId && !!loginServerId,
  });
  const loginList = logins.data?.logins ?? [];
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
  const valid =
    !!login && (mode === "create" ? /^[a-z][a-z0-9_]{0,40}$/.test(name) && !!serverId : !!existingId);

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
      <DialogContent>
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
            <>
              <div className="space-y-1">
                <Label>{t("Database server")}</Label>
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
                    <SelectTrigger>
                      <SelectValue placeholder={t("Choose a server")} />
                    </SelectTrigger>
                    <SelectContent>
                      {servers.data.map((server) => (
                        <SelectItem key={server.id} value={server.id}>
                          {server.name} · {server.version ?? ENGINE[server.engine]}
                          {server.default && ` · ${t("organization default")}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div className="space-y-1">
                <Label htmlFor="db-name">{t("Name")}</Label>
                <Input id="db-name" className="font-mono" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
                <p className="text-xs text-muted-foreground">{t("Lowercase letters, digits and underscores.")}</p>
              </div>
            </>
          ) : (
            <div className="space-y-1">
              <Label>{t("Database")}</Label>
              {existing.isLoading ? (
                <p className="text-sm text-muted-foreground">{t("Loading…")}</p>
              ) : choices.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("This organization has no databases yet — create a new one.")}</p>
              ) : (
                <Select value={existingId} onValueChange={setExistingId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t("Choose a database")} />
                  </SelectTrigger>
                  <SelectContent>
                    {choices.map((db) => (
                      <SelectItem key={db.id} value={db.id}>
                        {db.dbName || db.name} · {db.type === "POSTGRESQL" ? "PostgreSQL" : "MySQL"}
                        {db.application && db.application.id !== application.id && ` · ${t("used by {app}", { app: db.application.name })}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {loginServerId && (
            <div className="space-y-2">
              <Label>{t("Login")}</Label>
              <Choice<"new" | "existing">
                value={loginMode}
                onChange={setLoginMode}
                options={[
                  ["new", t("New login")],
                  ["existing", t("Existing login")],
                ]}
              />
              {loginMode === "new" ? (
                <div className="space-y-1">
                  <div className="flex items-center rounded-md border border-input focus-within:ring-2 focus-within:ring-ring">
                    <span className="select-none pl-3 font-mono text-sm text-muted-foreground">{logins.data?.prefix}</span>
                    <input
                      aria-label={t("Login name")}
                      className="h-10 min-w-0 flex-1 bg-transparent pr-3 font-mono text-sm outline-none"
                      value={loginName}
                      onChange={(e) => setLoginName(e.target.value.toLowerCase())}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("A login of its own for this app, with access to this database only.")}
                  </p>
                </div>
              ) : logins.isLoading ? (
                <p className="text-sm text-muted-foreground">{t("Loading…")}</p>
              ) : loginList.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("The organization has no logins on this server yet — make a new one.")}</p>
              ) : (
                <Select value={accountId} onValueChange={setAccountId}>
                  <SelectTrigger>
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

          <p className="text-xs text-muted-foreground">
            {t("Its URL is saved as {key}.", { key: envKey })}
            {alsoKeys.length > 0 && " " + t("Also fills {keys}.", { keys: alsoKeys.join(", ") })}
          </p>
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button type="submit" form="database-connect" disabled={!valid || busy}>
            {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {mode === "create" ? t("Create & connect") : t("Connect")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
