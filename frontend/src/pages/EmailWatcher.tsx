import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, MailSearch, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { useToast } from "@/hooks/use-toast";
import { getActiveOrg } from "@/lib/api";
import { isAdmin } from "@/lib/auth";
import { getOrganizations } from "@/lib/organizations";
import { addMailbox, detectMailbox, getMailboxes, type Detected, type Mailbox, type MailboxStatus } from "@/lib/emailWatcher";
import { locale, t } from "@/lib/i18n";

export const MAILBOXES_KEY = ["email-watcher", "mailboxes"];

export const when = (at: string | null) => (at ? new Date(at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : "—");

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
  const [adding, setAdding] = useState<Adding | null>(null);
  const [detecting, setDetecting] = useState(false);
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
          {m.status !== "OK" && m.status !== "PAUSED" && m.lastError && <p className="max-w-xs truncate text-xs text-destructive" title={m.lastError}>{m.lastError}</p>}
        </div>
      ),
    },
    { header: t("Rules"), cell: (m) => <span className="tabular-nums">{m.rules ?? 0}</span> },
    { header: t("Last checked"), cell: (m) => when(m.lastCheckedAt) },
  ];

  const detected = adding?.detected;

  return (
    <PageLayout
      icon={MailSearch}
      title={t("Email Watcher")}
      description={t("Larika reads new emails in your inbox as they arrive, picks the ones your rules match — like bank transfer notifications — and sends what it reads out to your app or WhatsApp.")}
      actions={
        <Button onClick={() => setAdding({ organizationId: getActiveOrg() ?? "", email: "", host: "", port: "993", username: "", password: "", detected: null })}>
          <Plus className="mr-2 h-4 w-4" /> {t("Add mailbox")}
        </Button>
      }
    >
      <p className="rounded-md bg-primary/5 p-3 text-sm">{t("Beta: one watched mailbox per account, free.")}</p>
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
