import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, CheckCircle, ExternalLink, Globe, Loader2, Plus, Settings2, Trash2, X } from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HostnamePicker, hostnameProblem, joinHost } from "@/components/HostnamePicker";
import { HostBadge, HostPointing, hostOk } from "@/components/HostCheck";
import { useApplicationHostname } from "@/hooks/useApplications";
import { useToast } from "@/hooks/use-toast";
import { type AppDomain, type Application, addAppDomain, bindingLabel, removeAppDomain } from "@/lib/applications";
import { getDomainChoices } from "@/lib/domains";
import { t } from "@/lib/i18n";

/** The redirect picker's "no redirect" — Radix Select takes no empty value. */
const SERVE = "__serve";

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
  dialogOnly = false,
  editOpen: controlledOpen,
  onEditOpenChange,
  onChange,
}: {
  application: Application;
  pending?: boolean;
  /** "Point it here" on a host answered by another server */
  onRepoint?: (host: string) => void;
  children?: React.ReactNode;
  /** one line — the hosts and Edit — for an app card opened in a list */
  compact?: boolean;
  /** the hosts dialog alone, opened with editOpen — a row elsewhere shows the hosts */
  dialogOnly?: boolean;
  /** the hosts dialog, opened from outside too (the setup checklist's Host step) */
  editOpen?: boolean;
  onEditOpenChange?: (open: boolean) => void;
  /** after a host is added or removed: the owner reads its app again — its own query, not only the cache's */
  onChange?: () => void;
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
    onChange?.();
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
  const serving = routes.filter((d) => !d.redirectTo);
  const redirects = routes.filter((d) => d.redirectTo);
  const removeButton = (route: AppDomain) => {
    const label = bindingLabel(route);
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
        disabled={!!busy}
        title={t("Remove {host}", { host: label })}
        aria-label={t("Remove {host}", { host: label })}
        onClick={() => setConfirmRemove(route)}
      >
        {busy === label ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
      </Button>
    );
  };

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
            <DialogTitle>{t("Manage hosts & redirects")}</DialogTitle>
            <DialogDescription>{t("The hosts and paths that go to {app}.", { app: application.name })}</DialogDescription>
          </DialogHeader>

          {/* two kinds, said apart: hosts that open the app, and hosts that send visitors on to one of them */}
          <section className="space-y-1.5">
            <p className="text-sm font-medium">
              {t("Hosts")} <span className="font-normal text-muted-foreground">({t("open {app}", { app: application.name })})</span>
            </p>
            <ul className="divide-y divide-border/60 rounded-md border border-border/60 empty:hidden">
              {serving.map((route) => {
                const label = bindingLabel(route);
                return (
                  <li key={label} className="flex items-center gap-3 px-3 py-2">
                    <span className="min-w-0 break-all font-mono text-sm">
                      {route.host}
                      {route.path && <span className="text-muted-foreground">{route.path}</span>}
                    </span>
                    <span className="ml-auto">{removeButton(route)}</span>
                  </li>
                );
              })}
            </ul>
          </section>

          {redirects.length > 0 && (
            <section className="space-y-1.5">
              <p className="text-sm font-medium">
                {t("Redirects")} <span className="font-normal text-muted-foreground">({t("to the host on the right, same path, 301")})</span>
              </p>
              <ul className="divide-y divide-border/60 rounded-md border border-border/60">
                {redirects.map((route) => {
                  const label = bindingLabel(route);
                  return (
                    <li key={label} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
                      <span className="min-w-0 break-all font-mono text-sm">
                        {route.host}
                        {route.path && <span className="text-muted-foreground">{route.path}</span>}
                      </span>
                      <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      {/* fixed once added: to change it, remove and add again */}
                      <span className="min-w-0 break-all font-mono text-sm">{route.redirectTo}</span>
                      <span className="ml-auto">{removeButton(route)}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

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
          {/* its only one: allowed, but it leaves the app unreachable — said before, not found after */}
          {confirmRemove && last && (
            <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {t("It is {app}'s only host: nobody reaches it until another one is added.", { app: application.name })}
            </p>
          )}
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

  if (dialogOnly) return editDialog;

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
              <Settings2 className="mr-1 h-3 w-3" />
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
            <Settings2 className="mr-2 h-3.5 w-3.5" />
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
                {route.redirectTo && (
                  <Badge variant="outline" className="font-mono text-[10px]" title={t("Visitors are sent on to {target}, with the same path.", { target: route.redirectTo })}>
                    → {route.redirectTo}
                  </Badge>
                )}
                {route.path && route.stripPrefix && !route.redirectTo && (
                  <Badge variant="outline" className="font-mono text-[10px]" title={t("The service gets the path without this prefix: /api/users arrives as /users.")}>
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
  const [withPath, setWithPath] = useState(false);
  const [hostBlocked, setHostBlocked] = useState(false);
  const [dnsConsent, setDnsConsent] = useState(false);
  const [move, setMove] = useState(false);
  const [adding, setAdding] = useState(false);
  // what the new route does: serve the app, or send visitors to one of its hosts that does
  const [redirectTo, setRedirectTo] = useState(SERVE);
  const targets = [...new Set(application.domains.filter((d) => !d.path && !d.redirectTo).map((d) => d.host))];
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
      // a move takes exactly this host+path from the app that has it; beside another app's path needs none
      const target = redirectTo === SERVE || redirectTo === host ? undefined : redirectTo;
      const { dns } = await addAppDomain(application.id, { host, path: nextPath, redirectTo: target, dnsConsent: dnsConsent || undefined, move: move || undefined });
      // the app it came from lost it
      if (move) void queryClient.invalidateQueries({ queryKey: ["application"] });
      const dnsProblem = ["conflict", "unavailable"].includes(dns.state);
      toast(
        dnsProblem
          ? { variant: "destructive", title: t("{host} added", { host: label }), description: dns.detail }
          : {
              title: t("{host} added", { host: label }),
              description: target ? t("Visitors are sent on to {target}, with the same path.", { target }) : t("It goes to {app}.", { app: application.name }),
            },
      );
      setSubdomain("");
      setPath("");
      // in the list at once — the refetch below only confirms it
      queryClient.setQueryData<Application>(["application", application.id], (prev) =>
        prev && !prev.domains.some((d) => d.host === host && (d.path ?? "") === nextPath)
          ? { ...prev, domains: [...prev.domains, { host, path: nextPath, stripPrefix: false, redirectTo: target ?? null, domainId: picked?.id ?? null } as AppDomain] }
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
      {/* a route opens the app; a redirect sends its visitors on to one of the hosts that does */}
      {targets.length > 0 ? (
        <div className="inline-flex rounded-md border border-border/60 p-0.5 text-sm" role="tablist">
          {[
            { redirect: false, label: t("Add route") },
            { redirect: true, label: t("Add redirect") },
          ].map((tab) => {
            const active = (redirectTo !== SERVE) === tab.redirect;
            return (
              <button
                key={tab.label}
                type="button"
                role="tab"
                aria-selected={active}
                className={`rounded px-3 py-1 font-medium transition-colors ${active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setRedirectTo(tab.redirect ? (redirectTo !== SERVE ? redirectTo : targets[0]!) : SERVE)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="text-sm font-medium">{t("Add route")}</p>
      )}
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
        onMoveChange={setMove}
        path={nextPath}
        root={root}
        onRoot={setRoot}
        trailing={
          <>
            {/* optional: a path under the host — other apps of the organization can have the rest; opened by "+ Path" */}
            {withPath ? (
              <div className="relative w-40 shrink-0">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm text-muted-foreground">/</span>
                <Input
                  autoFocus
                  className="px-6 font-mono text-sm"
                  value={path}
                  placeholder="api/*"
                  onChange={(e) => setPath(e.target.value.replace(/^\/+/, ""))}
                />
                <button
                  type="button"
                  title={t("Remove path")}
                  aria-label={t("Remove path")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setPath("");
                    setWithPath(false);
                  }}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              domain && (
                <Button type="button" variant="link" className="shrink-0 px-1" onClick={() => setWithPath(true)}>
                  + {t("Path")}
                </Button>
              )
            )}
            <Button
              className="shrink-0"
              onClick={() => void add()}
              // the picker checks this very host+path: another app's other paths of the host never block it
              disabled={!domain || !!problem || !!pathProblem || hostBlocked || adding || taken}
            >
              {adding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              {t("Add")}
            </Button>
          </>
        }
      />
      {pathProblem && <p className="text-xs text-destructive">{pathProblem}</p>}
      {/* a redirect needs a host of the app that serves it to go to */}
      {redirectTo !== SERVE && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t("Redirect to")}</span>
          <Select value={redirectTo} onValueChange={setRedirectTo}>
            <SelectTrigger className="h-8 w-auto max-w-[20rem] gap-1 font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {targets.map((target) => (
                <SelectItem key={target} value={target} className="font-mono">
                  {target}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">{t("with the same path (301)")}</span>
        </div>
      )}
    </div>
  );
}
