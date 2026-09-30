import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BookOpen, FlaskConical, KeyRound, List, Loader2, MailSearch, MessageCircle, Pause, Play, Plus, ScrollText, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CodeExample } from "@/components/CodeExample";
import { Step } from "@/components/QuickStartStep";
import { EventsTab, RulesTab } from "@/components/EmailWatcherTabs";
import { useToast } from "@/hooks/use-toast";
import { getActiveOrg } from "@/lib/api";
import { isAdmin } from "@/lib/auth";
import { getOrganizations } from "@/lib/organizations";
import {
  addMailbox,
  deleteMailbox,
  detectMailbox,
  EVENTS_KEY,
  getMailboxes,
  MAILBOXES_KEY,
  RULES_KEY,
  updateMailbox,
  when,
  type Detected,
  type Mailbox,
  type MailboxStatus,
} from "@/lib/emailWatcher";
import { t } from "@/lib/i18n";

/** idle: no rule is on, so nothing is watched yet — said instead of "Watching" */
function MailboxStatusBadge({ status, idle = false }: { status: MailboxStatus; idle?: boolean }) {
  if (status === "OK" && idle) return <Badge variant="outline">{t("No rule yet")}</Badge>;
  const label: Record<MailboxStatus, string> = { OK: t("Watching"), AUTH_FAILED: t("Login refused"), ERROR: t("Reconnecting"), PAUSED: t("Paused") };
  const variant = status === "OK" ? "default" : status === "PAUSED" ? "secondary" : "destructive";
  return <Badge variant={variant}>{label[status] ?? status}</Badge>;
}

/** How to get a password Larika may log in with, per provider (detectMailbox's `provider`). */
function PasswordGuide({ provider }: { provider: string | null }) {
  const steps: Record<string, string> = {
    gmail: t("Gmail needs an app password: turn on 2-Step Verification, then create one at myaccount.google.com/apppasswords and paste its 16 characters here."),
    google: t("Google Workspace needs an app password: turn on 2-Step Verification, then create one at myaccount.google.com/apppasswords. Your admin may have to allow app passwords."),
    yahoo: t("Yahoo needs an app password: Account security → Generate app password, at login.yahoo.com/account/security."),
    me: t("iCloud needs an app-specific password: appleid.apple.com → Sign-In and Security → App-Specific Passwords."),
    zoho: t("Turn on IMAP access in Zoho Mail's settings. With two-factor sign-in on, use an application-specific password."),
  };
  return (
    <p className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
      {(provider && steps[provider]) || t("Use the mailbox's own password. The server is usually mail.<your domain> — your hosting's email settings show it.")}
    </p>
  );
}

/** The provider of a saved mailbox, for its password guide. */
const providerOf = (host: string) => (host.includes("gmail") ? "gmail" : host.includes("yahoo") ? "yahoo" : host.includes("me.com") ? "me" : host.includes("zoho") ? "zoho" : null);

type Adding = { organizationId: string; email: string; host: string; port: string; username: string; password: string; detected: Detected | null };
type Login = { mailbox: Mailbox; host: string; port: string; username: string; password: string };

/**
 * Email Watcher: mailboxes Larika keeps an IMAP connection to, the rules run on their
 * new emails, and what the rules matched — one page, a tab each.
 */
export default function EmailWatcher() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = useTableQuery(10);
  const { data: rows = [], isFetching } = useQuery({ queryKey: MAILBOXES_KEY, queryFn: getMailboxes, refetchInterval: 30_000 });
  const [adding, setAdding] = useState<Adding | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [login, setLogin] = useState<Login | null>(null);
  const [removing, setRemoving] = useState<Mailbox | null>(null);
  // the tab is in the URL: the rule editor's back link lands on Rules
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab");
  const setTab = (next: string) => setParams({ tab: next }, { replace: true });
  const { data: orgs = [] } = useQuery({ queryKey: ["organizations"], queryFn: getOrganizations, enabled: !!adding });
  const manageable = orgs.filter((org) => isAdmin() || org.myRole === "OWNER" || org.myRole === "ADMIN");
  const showWorkspace = isAdmin() || new Set(rows.map((r) => r.organization?.id)).size > 1;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: MAILBOXES_KEY });
    void queryClient.invalidateQueries({ queryKey: RULES_KEY });
    void queryClient.invalidateQueries({ queryKey: EVENTS_KEY });
  };
  const failed = (title: string) => (e: Error) => toast({ title, description: e.message, variant: "destructive" });

  const create = useMutation({
    mutationFn: addMailbox,
    onSuccess: () => {
      setAdding(null);
      refresh();
      // next: its first rule
      setTab("rules");
    },
    onError: failed(t("Failed to add the mailbox")),
  });
  const pause = useMutation({ mutationFn: (m: Mailbox) => updateMailbox(m.id, { paused: m.status !== "PAUSED" }), onSuccess: refresh, onError: failed(t("Failed to update the mailbox")) });
  const saveLogin = useMutation({
    mutationFn: (l: Login) => updateMailbox(l.mailbox.id, { host: l.host, port: Number(l.port) || 993, secure: (Number(l.port) || 993) === 993, username: l.username, password: l.password }),
    onSuccess: () => {
      setLogin(null);
      refresh();
    },
    onError: failed(t("Failed to update the mailbox")),
  });
  const remove = useMutation({
    mutationFn: (m: Mailbox) => deleteMailbox(m.id),
    onSuccess: () => {
      setRemoving(null);
      refresh();
    },
    onError: failed(t("Failed to delete the mailbox")),
  });

  const detect = async (form: Adding) => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) return;
    setDetecting(true);
    try {
      const d = await detectMailbox(form.email);
      setAdding((a) => a && { ...a, detected: d, host: d.host, port: String(d.port), username: a.username || a.email });
    } catch {
      // typed by hand then
    } finally {
      setDetecting(false);
    }
  };

  const startLogin = (m: Mailbox) => setLogin({ mailbox: m, host: m.host, port: String(m.port), username: m.username, password: "" });

  const columns: Column<Mailbox>[] = [
    { header: t("Mailbox"), cell: (m) => <span className="font-medium">{m.email}</span> },
    ...(showWorkspace ? [{ header: t("Workspace"), cell: (m: Mailbox) => m.organization?.name ?? "—" }] : []),
    {
      header: t("Status"),
      cell: (m) => (
        <div className="space-y-1">
          <MailboxStatusBadge status={m.status} idle={!m.activeRules} />
          {m.status !== "OK" && m.lastError && (
            <p className="max-w-xs truncate text-xs text-destructive" title={m.lastError}>
              {m.lastError}
            </p>
          )}
        </div>
      ),
    },
    { header: t("Rules"), cell: (m) => <span className="tabular-nums">{m.rules ?? 0}</span> },
    { header: t("Last checked"), cell: (m) => when(m.lastCheckedAt) },
    {
      header: "",
      className: "w-32 text-right",
      cell: (m) =>
        m.canManage && (
          <>
            <Button
              variant="ghost"
              size="sm"
              aria-label={m.status === "PAUSED" ? t("Resume") : t("Pause")}
              title={m.status === "PAUSED" ? t("Resume") : t("Pause")}
              disabled={pause.isPending}
              onClick={() => pause.mutate(m)}
            >
              {m.status === "PAUSED" ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            </Button>
            <Button variant={m.status === "AUTH_FAILED" ? "destructive" : "ghost"} size="sm" aria-label={t("Login")} title={t("Login")} onClick={() => startLogin(m)}>
              <KeyRound className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" aria-label={t("Delete mailbox")} title={t("Delete mailbox")} onClick={() => setRemoving(m)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </>
        ),
    },
  ];

  const detected = adding?.detected;
  const startAdding = () => setAdding({ organizationId: getActiveOrg() ?? "", email: "", host: "", port: "993", username: "", password: "", detected: null });

  return (
    <PageLayout
      icon={MailSearch}
      title={t("Email Watcher")}
      description={t("Reads incoming emails, like bank notifications, and sends their data to your app or WhatsApp.")}
      actions={
        <Button onClick={startAdding}>
          <Plus className="mr-2 h-4 w-4" /> {t("Add mailbox")}
        </Button>
      }
    >
      {/* a workspace with no mailboxes yet lands on the guide */}
      <Tabs value={tab ?? (!isFetching && !rows.length ? "start" : "mailboxes")} onValueChange={setTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="start">
            <BookOpen className="mr-2 h-4 w-4" />
            {t("Quick start")}
          </TabsTrigger>
          <TabsTrigger value="mailboxes">
            <List className="mr-2 h-4 w-4" />
            {t("Mailboxes")}
            {rows.length > 0 && ` (${rows.length})`}
          </TabsTrigger>
          <TabsTrigger value="rules">
            <FlaskConical className="mr-2 h-4 w-4" />
            {t("Rules")}
          </TabsTrigger>
          <TabsTrigger value="events">
            <ScrollText className="mr-2 h-4 w-4" />
            {t("Log")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="start">
          <QuickStart rows={rows} onAdd={startAdding} onRules={() => setTab("rules")} />
        </TabsContent>
        <TabsContent value="mailboxes">
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(m) => m.id}
            query={query}
            filter={(m, search) => m.email.toLowerCase().includes(search.toLowerCase())}
            isLoading={isFetching && !rows.length}
            searchPlaceholder={t("Search mailboxes…")}
            empty={t("No mailboxes yet. Add the inbox your bank or payment notifications arrive in.")}
          />
        </TabsContent>
        <TabsContent value="rules">
          <RulesTab mailboxes={rows} />
        </TabsContent>
        <TabsContent value="events">
          <EventsTab manyMailboxes={rows.length > 1} />
        </TabsContent>
      </Tabs>

      <Dialog open={!!adding} onOpenChange={(o) => !o && setAdding(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Add mailbox")}</DialogTitle>
            <DialogDescription>{t("Larika logs in over IMAP and only reads. Emails your rules do not match are never stored.")}</DialogDescription>
          </DialogHeader>
          {adding && (
            <form
              id="add-mailbox"
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate({
                  organizationId: adding.organizationId || undefined,
                  email: adding.email.trim(),
                  host: adding.host.trim(),
                  port: Number(adding.port) || 993,
                  secure: (Number(adding.port) || 993) === 993,
                  username: adding.username.trim() || adding.email.trim(),
                  password: adding.password,
                } as Parameters<typeof addMailbox>[0]);
              }}
            >
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
              <div className="space-y-1">
                <Label htmlFor="mailbox-email">{t("Email address")}</Label>
                <Input
                  id="mailbox-email"
                  type="email"
                  required
                  autoFocus
                  placeholder="finance@tokoanda.com"
                  value={adding.email}
                  onChange={(e) => setAdding({ ...adding, email: e.target.value, detected: null })}
                  onBlur={() => void detect(adding)}
                />
              </div>
              {detecting && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              {detected?.unsupported ? (
                <p className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  {t(detected.unsupported)}
                </p>
              ) : (
                detected && (
                  <>
                    <PasswordGuide provider={detected.provider} />
                    <div className="grid grid-cols-[1fr_6rem] gap-2">
                      <div className="space-y-1">
                        <Label htmlFor="mailbox-host">{t("IMAP server")}</Label>
                        <Input id="mailbox-host" required value={adding.host} onChange={(e) => setAdding({ ...adding, host: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="mailbox-port">{t("Port")}</Label>
                        <Input id="mailbox-port" type="number" required value={adding.port} onChange={(e) => setAdding({ ...adding, port: e.target.value })} />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="mailbox-username">{t("Username")}</Label>
                      <Input id="mailbox-username" value={adding.username} placeholder={adding.email} onChange={(e) => setAdding({ ...adding, username: e.target.value })} />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="mailbox-password">{detected.provider ? t("App password") : t("Password")}</Label>
                      <Input id="mailbox-password" type="password" required autoComplete="off" value={adding.password} onChange={(e) => setAdding({ ...adding, password: e.target.value })} />
                    </div>
                  </>
                )
              )}
            </form>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdding(null)} disabled={create.isPending}>
              {t("Cancel")}
            </Button>
            {detected && !detected.unsupported ? (
              <Button type="submit" form="add-mailbox" disabled={create.isPending}>
                {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t("Test and add")}
              </Button>
            ) : (
              <Button disabled={!adding?.email || detecting || !!detected?.unsupported} onClick={() => adding && void detect(adding)}>
                {t("Next")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!login} onOpenChange={(o) => !o && setLogin(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Login for {email}", { email: login?.mailbox.email ?? "" })}</DialogTitle>
            <DialogDescription>{t("Tested before it is saved. The watcher reconnects with it and reads what arrived meanwhile.")}</DialogDescription>
          </DialogHeader>
          {login && (
            <form
              id="mailbox-login"
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                saveLogin.mutate(login);
              }}
            >
              {login.mailbox.lastError && login.mailbox.status === "AUTH_FAILED" && <p className="text-sm text-destructive">{login.mailbox.lastError}</p>}
              <PasswordGuide provider={providerOf(login.mailbox.host)} />
              <div className="grid grid-cols-[1fr_6rem] gap-2">
                <div className="space-y-1">
                  <Label htmlFor="login-host">{t("IMAP server")}</Label>
                  <Input id="login-host" required value={login.host} onChange={(e) => setLogin({ ...login, host: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="login-port">{t("Port")}</Label>
                  <Input id="login-port" type="number" required value={login.port} onChange={(e) => setLogin({ ...login, port: e.target.value })} />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="login-username">{t("Username")}</Label>
                <Input id="login-username" required value={login.username} onChange={(e) => setLogin({ ...login, username: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="login-password">{t("Password or app password")}</Label>
                <Input id="login-password" type="password" required autoFocus autoComplete="off" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} />
              </div>
            </form>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setLogin(null)} disabled={saveLogin.isPending}>
              {t("Cancel")}
            </Button>
            <Button type="submit" form="mailbox-login" disabled={saveLogin.isPending}>
              {saveLogin.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("Test and save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Delete {name}?", { name: removing?.email ?? "" })}</DialogTitle>
            <DialogDescription>{t("Larika stops reading it and deletes its rules and events. The emails stay in the mailbox.")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)} disabled={remove.isPending}>
              {t("Cancel")}
            </Button>
            <Button variant="destructive" onClick={() => removing && remove.mutate(removing)} disabled={remove.isPending}>
              {remove.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("Delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageLayout>
  );
}

const PAYLOAD = JSON.stringify(
  {
    event: "email.matched",
    id: "cm1x…",
    rule: { id: "cm1r…", name: "BNI Merchant" },
    mailbox: "finance@tokoanda.com",
    message: {
      id: "<…@bni.co.id>",
      from: "BNI Merchant <merchant@bni.co.id>",
      subject: "BNI Merchant - Transaksi Sebesar Rp 150,000.00 dari DANA telah berhasil",
      receivedAt: "2026-09-20T08:15:00.000Z",
    },
    verified: true,
    data: { amount: 150000, source: "DANA" },
  },
  null,
  2,
);

const VERIFY = `// the rule's webhook key, shown in the rule
if (req.headers["x-larika-webhook-key"] !== process.env.WEBHOOK_KEY) {
  return res.status(401).end();
}
const { id, verified, data } = req.body; // data.amount = 150000, data.source = "DANA"
// sent at least once: skip an id you have already handled
res.status(200).end();`;

/** From nothing to parsed notifications in an app, each step ticked off from the real mailboxes. */
function QuickStart({ rows, onAdd, onRules }: { rows: Mailbox[]; onAdd: () => void; onRules: () => void }) {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Step n={1} done={rows.length > 0} title={t("Connect the inbox your notifications arrive in")}>
        <p className="text-sm text-muted-foreground">
          {t("Gmail, Yahoo and iCloud need an app password (2-step verification on); email on your own domain uses its normal password. Larika only reads, and never stores an email your rules do not match.")}
        </p>
        {!rows.length && (
          <Button size="sm" onClick={onAdd}>
            <Plus className="mr-2 h-4 w-4" />
            {t("Add mailbox")}
          </Button>
        )}
      </Step>

      <Step n={2} done={rows.some((m) => (m.rules ?? 0) > 0)} title={t("Make a rule and try it on real emails")}>
        <p className="text-sm text-muted-foreground">
          {t("Pick emails by sender and subject (or start from the BNI Merchant preset), add the fields to read — a regular expression each — and press Try: the last 30 days of your inbox show what the rule would read out.")}
        </p>
        {rows.some((m) => m.canManage) && (
          <Button variant="outline" size="sm" onClick={onRules}>
            <FlaskConical className="mr-2 h-4 w-4" />
            {t("Rules")}
          </Button>
        )}
      </Step>

      <Step n={3} title={t("Receive it in your app with a webhook")}>
        <p className="text-sm text-muted-foreground">
          {t("Set a webhook URL on the rule. Each matched email is POSTed there as JSON within seconds, with the rule's webhook key in")}{" "}
          <code className="font-mono text-xs">x-larika-webhook-key</code>. {t("Failed sends are retried for about 9 hours.")}
        </p>
        <CodeExample examples={[{ label: "Payload", code: PAYLOAD, lang: "json" }, { label: "Node.js", code: VERIFY, lang: "js" }]} />
      </Step>

      <Step n={4} title={t("Or get it on WhatsApp")}>
        <p className="text-sm text-muted-foreground">
          {t("With a number on WA Gateway, a rule can message you for each match — like “Masuk Rp {amount} dari {source}” — using the fields it read.")}
        </p>
        <Button variant="outline" size="sm" asChild>
          <a href="/wa-gateway">
            <MessageCircle className="mr-2 h-4 w-4" />
            WA Gateway
          </a>
        </Button>
      </Step>
    </div>
  );
}
