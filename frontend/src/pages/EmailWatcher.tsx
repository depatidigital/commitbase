import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BookOpen, List, Loader2, MailSearch, MessageCircle, Plus } from "lucide-react";
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
import { useToast } from "@/hooks/use-toast";
import { getActiveOrg } from "@/lib/api";
import { isAdmin } from "@/lib/auth";
import { getOrganizations } from "@/lib/organizations";
import { getRates } from "@/lib/billing";
import { rupiah } from "@/lib/ai";
import { addMailbox, detectMailbox, getMailboxes, MAILBOXES_KEY, when, type Detected, type Mailbox, type MailboxStatus } from "@/lib/emailWatcher";
import { t } from "@/lib/i18n";

export function MailboxStatusBadge({ status }: { status: MailboxStatus }) {
  const label: Record<MailboxStatus, string> = { OK: t("Watching"), AUTH_FAILED: t("Login refused"), ERROR: t("Reconnecting"), PAUSED: t("Paused") };
  const variant = status === "OK" ? "default" : status === "PAUSED" ? "secondary" : "destructive";
  return <Badge variant={variant}>{label[status] ?? status}</Badge>;
}

/** How to get a password Larika may log in with, per provider (detectMailbox's `provider`). */
export function PasswordGuide({ provider }: { provider: string | null }) {
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

type Adding = { organizationId: string; email: string; host: string; port: string; username: string; password: string; detected: Detected | null };

/**
 * Email Watcher: mailboxes Larika keeps an IMAP connection to, reading new emails as
 * they arrive and running the mailbox's rules on them.
 */
export default function EmailWatcher() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useTableQuery(10);
  const { data: rows = [], isFetching } = useQuery({ queryKey: MAILBOXES_KEY, queryFn: getMailboxes, refetchInterval: 30_000 });
  const { data: rates } = useQuery({ queryKey: ["billing", "rates"], queryFn: getRates, staleTime: 10 * 60_000 });
  const [adding, setAdding] = useState<Adding | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [tab, setTab] = useState<string | null>(null);
  const { data: orgs = [] } = useQuery({ queryKey: ["organizations"], queryFn: getOrganizations, enabled: !!adding });
  const manageable = orgs.filter((org) => isAdmin() || org.myRole === "OWNER" || org.myRole === "ADMIN");
  const showWorkspace = isAdmin() || new Set(rows.map((r) => r.organization?.id)).size > 1;

  const create = useMutation({
    mutationFn: addMailbox,
    onSuccess: ({ id }) => {
      setAdding(null);
      void queryClient.invalidateQueries({ queryKey: MAILBOXES_KEY });
      navigate(`/email-watcher/${id}`);
    },
    onError: (e: Error) => toast({ title: t("Failed to add the mailbox"), description: e.message, variant: "destructive" }),
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

  const columns: Column<Mailbox>[] = [
    { header: t("Mailbox"), cell: (m) => <span className="font-medium">{m.email}</span> },
    ...(showWorkspace ? [{ header: t("Workspace"), cell: (m: Mailbox) => m.organization?.name ?? "—" }] : []),
    {
      header: t("Status"),
      cell: (m) => (
        <div className="space-y-1">
          <MailboxStatusBadge status={m.status} />
          {m.status !== "OK" && m.lastError && <p className="max-w-xs truncate text-xs text-destructive" title={m.lastError}>{m.lastError}</p>}
        </div>
      ),
    },
    { header: t("Rules"), cell: (m) => <span className="tabular-nums">{m.rules ?? 0}</span> },
    { header: t("Last checked"), cell: (m) => when(m.lastCheckedAt) },
  ];

  const detected = adding?.detected;
  const startAdding = () => setAdding({ organizationId: getActiveOrg() ?? "", email: "", host: "", port: "993", username: "", password: "", detected: null });

  return (
    <PageLayout
      icon={MailSearch}
      title={t("Email Watcher")}
      description={t("Larika reads new emails in your inbox as they arrive, picks the ones your rules match — like bank transfer notifications — and sends what it reads out to your app or WhatsApp.")}
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
        </TabsList>
        <TabsContent value="start">
          <QuickStart rows={rows} price={rates ? rupiah(rates.email.mailboxDay) : null} onAdd={startAdding} onOpen={(m) => navigate(`/email-watcher/${m.id}`)} />
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
            onRowClick={(m) => m.canManage && navigate(`/email-watcher/${m.id}`)}
          />
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
function QuickStart({ rows, price, onAdd, onOpen }: { rows: Mailbox[]; price: string | null; onAdd: () => void; onOpen: (m: Mailbox) => void }) {
  const first = rows.find((m) => m.canManage);
  const withRule = rows.find((m) => m.canManage && (m.rules ?? 0) > 0);
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {price && (
        <p className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">
          {t("{price} per mailbox per day from your balance, only on days it is watched. Paused mailboxes cost nothing.", { price })}
        </p>
      )}

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

      <Step n={2} done={!!withRule} title={t("Make a rule and try it on real emails")}>
        <p className="text-sm text-muted-foreground">
          {t("Pick emails by sender and subject (or start from the BNI Merchant preset), add the fields to read — a regular expression each — and press Try: the last 30 days of your inbox show what the rule would read out.")}
        </p>
        {first && (
          <Button variant="outline" size="sm" onClick={() => onOpen(withRule ?? first)}>
            <MailSearch className="mr-2 h-4 w-4" />
            {t("Rules of {email}", { email: (withRule ?? first).email })}
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
          {t("With a number on Whatsapp Gateway API, a rule can message you for each match — like “Masuk Rp {amount} dari {source}” — using the fields it read.")}
        </p>
        <Button variant="outline" size="sm" asChild>
          <a href="/wa-gateway">
            <MessageCircle className="mr-2 h-4 w-4" />
            Whatsapp Gateway API
          </a>
        </Button>
      </Step>
    </div>
  );
}
