import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle, ExternalLink, Globe, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { HostnamePicker, hostnameProblem, joinHost } from "@/components/HostnamePicker";
import { HostBadge, HostPointing, hostOk } from "@/components/HostCheck";
import { useApplicationHostname } from "@/hooks/useApplications";
import { useToast } from "@/hooks/use-toast";
import { type AppDomain, type Application, addAppDomain, bindingLabel, removeAppDomain } from "@/lib/applications";
import { getDomainChoices } from "@/lib/domains";
import { t } from "@/lib/i18n";

/** A path as someone types it: "" for the whole host, else `/api/*`-like. */
const PATH = /^\/[A-Za-z0-9._~\-/]*\*?$/;

/**
 * The app's Host card, on its overview: the hosts it answers on, or paths
 * under one (`app.example.com/api/*`) — all alike, a route belongs to one app —
 * each checked where visitors reach it. Read-only here; "Edit" opens a dialog
 * to add, change and take them off. The host's route is composed again with
 * every app on it, and the last route stays — an app with none is nothing
 * anyone can reach. Zones, DNS and expiry are the Domains page's, not here.
 * `children`: more lines under the hosts.
 */
export function RoutingCard({
  application,
  pending,
  onRepoint,
  children,
  compact = false,
  editOpen: controlledOpen,
  onEditOpenChange,
}: {
  application: Application;
  pending?: boolean;
  /** "Point it here" on a host answered by another server */
  onRepoint?: (host: string) => void;
  children?: React.ReactNode;
  /** one line — the hosts and Edit — for an app card opened in a list */
  compact?: boolean;
  /** the hosts dialog, opened from outside too (the setup checklist's Host step) */
  editOpen?: boolean;
  onEditOpenChange?: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // each route checked at its own host and path — the same query the app page polls
  const { data: checks } = useApplicationHostname(application.id);
  const [ownOpen, setOwnOpen] = useState(false);
  const editOpen = controlledOpen ?? ownOpen;
  const setEditOpen = onEditOpenChange ?? setOwnOpen;
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<AppDomain | null>(null);

  // by host, the whole host after its paths — the order Caddy tries them in
  const routes = [...application.domains].sort(
    (a, b) => a.host.localeCompare(b.host) || Number(!a.path) - Number(!b.path) || (a.path ?? "").localeCompare(b.path ?? ""),
  );

  const refresh = async () => {
    // exact: not its repository detection (a clone) — a host changes nothing there
    await queryClient.invalidateQueries({ queryKey: ["application", application.id], exact: true });
    void queryClient.invalidateQueries({ queryKey: ["applications"] });
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
    void queryClient.invalidateQueries({ queryKey: ["project"] });
    void queryClient.invalidateQueries({ queryKey: ["domains", "choices"] });
  };

  // one change at a time, named by its route
  const change = async (route: AppDomain, run: () => Promise<void>, failed: string, done?: string) => {
    setBusy(bindingLabel(route));
    try {
      await run();
      if (done) toast({ title: done });
      await refresh();
    } catch (error) {
      toast({ variant: "destructive", title: failed, description: error instanceof Error ? error.message : "" });
    } finally {
      setBusy(null);
    }
  };

  // values that spell out an address — the app's own URL — do not follow a removed host
  const staleEnv = (host: string) =>
    Object.entries(application.envVars ?? {})
      .filter(([, value]) => String(value).includes(host))
      .map(([key]) => key);
  const last = application.domains.length === 1;

  // a status mark per route: a tick when it answers from here, else what is wrong
  const status = (route: AppDomain) => {
    const check = checks?.find((c) => c.host === route.host && (c.path ?? "") === (route.path ?? ""));
    if (!check) return null;
    return hostOk(check) ? (
      <span title={t("Points at this server")}>
        <CheckCircle className="h-3.5 w-3.5 text-success" aria-label={t("Points at this server")} />
      </span>
    ) : (
      <>
        {/* compact: the mark alone, what it means on hover */}
        <HostBadge host={route.host} check={check} pending={pending} iconOnly={compact} onRepoint={onRepoint && (() => onRepoint(route.host))} />
        {!compact && check.pointing?.state === "elsewhere" && <HostPointing check={check} />}
      </>
    );
  };

  const editDialog = (
    <>
      <Dialog open={editOpen} onOpenChange={(open) => !busy && setEditOpen(open)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-auto">
          <DialogHeader>
            <DialogTitle>{t("Edit hosts")}</DialogTitle>
            <DialogDescription>{t("The hosts and paths that go to {app}.", { app: application.name })}</DialogDescription>
          </DialogHeader>

          <ul className="divide-y divide-border/60 rounded-md border border-border/60 empty:hidden">
            {routes.map((route) => {
              const label = bindingLabel(route);
              return (
                <li key={label} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
                  <span className="min-w-0 break-all font-mono text-sm">
                    {route.host}
                    {route.path && <span className="text-muted-foreground">{route.path}</span>}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    disabled={last || !!busy}
                    title={last ? t("An app needs at least one host — add another first") : t("Remove {host}", { host: label })}
                    aria-label={t("Remove {host}", { host: label })}
                    onClick={() => setConfirmRemove(route)}
                  >
                    {busy === label ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </Button>
                </li>
              );
            })}
          </ul>

          <Separator />
          <AddRouteForm application={application} onAdded={refresh} />
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmRemove} onOpenChange={(open) => !busy && !open && setConfirmRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Remove {host}?", { host: confirmRemove ? bindingLabel(confirmRemove) : "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("{host} stops going to {app}. When nothing else answers on the host, its DNS record pointing here is removed too. Links and bookmarks to it break.", {
                host: confirmRemove ? bindingLabel(confirmRemove) : "",
                app: application.name,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmRemove && staleEnv(confirmRemove.host).length > 0 && (
            <p className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/5 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              {t("{keys} still hold this address — update them in Environment and redeploy.", { keys: staleEnv(confirmRemove.host).join(", ") })}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busy}>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                if (!confirmRemove) return;
                const route = confirmRemove;
                void change(
                  route,
                  async () => {
                    await removeAppDomain(application.id, route.host, route.path ?? "");
                    // off the list at once — the refetch only confirms it
                    queryClient.setQueryData<Application>(["application", application.id], (prev) =>
                      prev ? { ...prev, domains: prev.domains.filter((d) => !(d.host === route.host && (d.path ?? "") === (route.path ?? ""))) } : prev,
                    );
                  },
                  t("Could not remove the route"),
                  t("{host} removed", { host: bindingLabel(route) }),
                ).then(() => setConfirmRemove(null));
              }}
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("Remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

  // no host yet: the one thing to do is add one — said where the list would be
  const addFirst = (
    <Button
      variant="outline"
      size="sm"
      className={`w-full border-dashed ${compact ? "h-8 text-xs" : ""}`}
      onClick={() => setEditOpen(true)}
    >
      <Plus className={compact ? "mr-1 h-3.5 w-3.5" : "mr-2 h-4 w-4"} />
      {t("Add domain / host")}
    </Button>
  );

  if (compact) {
    return (
      // a small card: Host and Manage on top, then one host a line — each opens in a new tab, with its status
      <div className="min-w-0 space-y-1.5 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 font-medium text-muted-foreground">
            <Globe className="h-3.5 w-3.5 text-primary" />
            {t("Host")}
          </p>
          {routes.length > 0 && (
            <Button variant="ghost" size="sm" className="-my-1 h-6 px-2 text-xs" onClick={() => setEditOpen(true)}>
              <Pencil className="mr-1 h-3 w-3" />
              {t("Manage")}
            </Button>
          )}
        </div>
        {routes.length === 0 && addFirst}
        <ul className="space-y-1 empty:hidden">
          {routes.map((route) => (
            <li key={bindingLabel(route)} className="flex min-w-0 items-center gap-1.5">
              <a
                href={`https://${route.host}${route.path ? route.path.replace(/\*+$/, "") : ""}`}
                target="_blank"
                rel="noreferrer"
                title={bindingLabel(route)}
                className="flex min-w-0 items-center gap-1 font-mono hover:text-primary"
              >
                <span className="truncate">
                  {route.host}
                  {route.path && <span className="text-muted-foreground">{route.path}</span>}
                </span>
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
              {status(route)}
            </li>
          ))}
        </ul>
        {editDialog}
      </div>
    );
  }

  return (
    <Card className="bg-gradient-card border-border/50">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0 pb-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="h-4 w-4 text-primary" />
            {t("Host")}
          </CardTitle>
          <p className="mt-1.5 text-xs text-muted-foreground">{t("What visitors get")}</p>
        </div>
        {routes.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            <Pencil className="mr-2 h-3.5 w-3.5" />
            {t("Manage")}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2 pt-3 pb-2">
        {routes.length === 0 && addFirst}
        {/* read-only: where it answers, and whether each answers */}
        <ul className="divide-y divide-border/60 rounded-md border border-border/60 empty:hidden">
          {routes.map((route) => {
            const label = bindingLabel(route);
            return (
              <li key={label} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
                <a
                  href={`https://${route.host}${route.path ? route.path.replace(/\*+$/, "") : ""}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-w-0 items-center gap-1.5 break-all font-mono text-sm hover:text-primary"
                >
                  {route.host}
                  {route.path && <span className="text-muted-foreground">{route.path}</span>}
                  <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                </a>
                {/* a path whose prefix is dropped says so */}
                {route.path && route.stripPrefix && (
                  <Badge variant="outline" className="font-mono text-[10px]" title={t("The app gets the path without this prefix: /api/users arrives as /users.")}>
                    {route.path} → /
                  </Badge>
                )}
                <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
                  {/* reachable: a tick, nothing more. Anything else says what is wrong */}
                  {status(route)}
                </span>
              </li>
            );
          })}
        </ul>
        {children}
      </CardContent>
      {/* everything that changes a route, in one place */}
      {editDialog}
    </Card>
  );
}

/** Adding a route, in the Edit dialog: a host, or a path under one. */
function AddRouteForm({ application, onAdded }: { application: Application; onAdded: () => Promise<void> }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: allChoices = [], isLoading } = useQuery({ queryKey: ["domains", "choices"], queryFn: getDomainChoices });
  // a host keeps the app in its org: shared zones, and that org's own
  const choices = useMemo(
    () => allChoices.filter((choice) => choice.shared || choice.organizationId === application.organizationId),
    [allChoices, application.organizationId],
  );

  const [domain, setDomain] = useState("");
  const [subdomain, setSubdomain] = useState("");
  // an owned domain is the route itself until "+ Subdomain" is clicked
  const [root, setRoot] = useState(true);
  const [path, setPath] = useState("");
  const [hostBlocked, setHostBlocked] = useState(false);
  const [dnsConsent, setDnsConsent] = useState(false);
  const [adding, setAdding] = useState(false);
  const picked = choices.find((choice) => choice.name === domain);
  const useRoot = root && !!picked && !picked.shared;
  const host = joinHost(subdomain, domain, useRoot);
  // the leading "/" is fixed in the field, so `path` is only what comes after it
  const nextPath = path.trim() ? `/${path.trim()}` : "";
  const pathProblem = nextPath && !PATH.test(nextPath) ? t("A path is like /api/* — or leave it empty for the whole host") : null;
  const problem = hostnameProblem(subdomain, picked, useRoot);
  const taken = application.domains.some((d) => d.host === host && (d.path ?? "") === nextPath);

  const add = async () => {
    setAdding(true);
    const label = `${host}${nextPath}`;
    try {
      const { dns } = await addAppDomain(application.id, { host, path: nextPath, dnsConsent: dnsConsent || undefined });
      const dnsProblem = ["conflict", "unavailable"].includes(dns.state);
      toast(
        dnsProblem
          ? { variant: "destructive", title: t("{host} added", { host: label }), description: dns.detail }
          : { title: t("{host} added", { host: label }), description: t("It goes to {app}.", { app: application.name }) },
      );
      setSubdomain("");
      setPath("");
      // in the list at once — the refetch below only confirms it
      queryClient.setQueryData<Application>(["application", application.id], (prev) =>
        prev && !prev.domains.some((d) => d.host === host && (d.path ?? "") === nextPath)
          ? { ...prev, domains: [...prev.domains, { host, path: nextPath, stripPrefix: false, domainId: picked?.id ?? null } as AppDomain] }
          : prev,
      );
      await onAdded();
    } catch (error) {
      toast({ variant: "destructive", title: t("Could not add the route"), description: error instanceof Error ? error.message : "" });
    } finally {
      setAdding(false);
    }
  };

  if (isLoading) return <Loader2 className="h-5 w-5 animate-spin" />;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{t("Add route")}</p>
      {/* one line: subdomain . domain, an optional path under it, Add */}
      <HostnamePicker
        bare
        choices={choices}
        subdomain={subdomain}
        domain={domain}
        onSubdomain={setSubdomain}
        onDomain={setDomain}
        excludeAppId={application.id}
        onBlockedChange={setHostBlocked}
        onConsentChange={setDnsConsent}
        root={root}
        onRoot={setRoot}
        trailing={
          <>
            {/* optional: a path under the host — other apps of the organization can have the rest */}
            <div className="relative w-40 shrink-0">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm text-muted-foreground">/</span>
              <Input
                className="pl-6 font-mono text-sm"
                value={path}
                placeholder={t("api/* (optional)")}
                onChange={(e) => setPath(e.target.value.replace(/^\/+/, ""))}
              />
            </div>
            <Button
              className="shrink-0"
              onClick={() => void add()}
              // a path on a host the organization already serves is not "blocked": the host is shared by path
              disabled={!domain || !!problem || !!pathProblem || (hostBlocked && !nextPath) || adding || taken}
            >
              {adding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              {t("Add")}
            </Button>
          </>
        }
      />
      {pathProblem && <p className="text-xs text-destructive">{pathProblem}</p>}
    </div>
  );
}
