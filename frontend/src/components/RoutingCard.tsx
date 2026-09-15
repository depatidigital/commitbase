import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle, ExternalLink, Loader2, Plus, Route, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { type AppDomain, type Application, addAppDomain, bindingLabel, removeAppDomain, setBindingStripPrefix } from "@/lib/applications";
import { getDomainChoices } from "@/lib/domains";
import { t } from "@/lib/i18n";

/** A path as someone types it: "" for the whole host, else `/api/*`-like. */
const PATH = /^\/[A-Za-z0-9._~\-/]*\*?$/;

/**
 * An app's routing: the hosts it answers on, or paths under one
 * (`app.example.com/api/*`) — all alike, a route belongs to one app. Add one,
 * take one off; the host's route is composed again with every app on it, and
 * the last route stays — an app with none is nothing anyone can reach. Zones,
 * DNS and expiry are the Domains page's, not here.
 */
export function RoutingCard({
  application,
  pending,
  onRepoint,
}: {
  application: Application;
  pending?: boolean;
  /** "Point it here" on a host answered by another server */
  onRepoint?: (host: string) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // each route checked at its own host and path — the same query the app page polls
  const { data: checks } = useApplicationHostname(application.id);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<AppDomain | null>(null);

  // by host, the whole host after its paths — the order Caddy tries them in
  const routes = [...application.domains].sort(
    (a, b) => a.host.localeCompare(b.host) || Number(!a.path) - Number(!b.path) || (a.path ?? "").localeCompare(b.path ?? ""),
  );

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["application", application.id] });
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

  return (
    <Card className="bg-gradient-card border-border/50">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Route className="h-5 w-5 text-primary" />
            {t("Routing")}
          </CardTitle>
          <p className="mt-1.5 text-sm text-muted-foreground">{t("The hosts and paths this app answers on")}</p>
        </div>
        <AddRoute application={application} onAdded={refresh} />
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border/60 rounded-md border border-border/60">
          {routes.map((route) => {
            const label = bindingLabel(route);
            const check = checks?.find((c) => c.host === route.host && (c.path ?? "") === (route.path ?? ""));
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
                {/* a path: whether the app gets /api/users, or /users */}
                {route.path && (
                  <label
                    className="flex items-center gap-1.5 text-xs text-muted-foreground"
                    title={t("The app gets the path without this prefix: /api/users arrives as /users.")}
                  >
                    <Checkbox
                      checked={!!route.stripPrefix}
                      disabled={busy === label}
                      onCheckedChange={(checked) =>
                        void change(route, () => setBindingStripPrefix(application.id, route.host, route.path ?? "", checked === true), t("Could not change the route"))
                      }
                    />
                    {t("strip prefix")}
                  </label>
                )}
                <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
                  {/* reachable: a tick, nothing more. Anything else says what is wrong */}
                  {check &&
                    (hostOk(check) ? (
                      <span title={t("Points at this server")}>
                        <CheckCircle className="h-4 w-4 text-success" aria-label={t("Points at this server")} />
                      </span>
                    ) : (
                      <>
                        <HostBadge host={route.host} check={check} pending={pending} onRepoint={onRepoint && (() => onRepoint(route.host))} />
                        {check.pointing?.state === "elsewhere" && <HostPointing check={check} />}
                      </>
                    ))}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    disabled={last || !!busy}
                    title={last ? t("An app needs at least one host — add another first") : t("Remove {host}", { host: label })}
                    aria-label={t("Remove {host}", { host: label })}
                    onClick={() => setConfirmRemove(route)}
                  >
                    {busy === label ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>

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
                  () => removeAppDomain(application.id, route.host, route.path ?? ""),
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
    </Card>
  );
}

/** "Add route": a host, or a path under one, in a modal. */
function AddRoute({ application, onAdded }: { application: Application; onAdded: () => Promise<void> }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const { data: allChoices = [], isLoading } = useQuery({ queryKey: ["domains", "choices"], queryFn: getDomainChoices, enabled: open });
  // a host keeps the app in its org: shared zones, and that org's own
  const choices = useMemo(
    () => allChoices.filter((choice) => choice.shared || choice.organizationId === application.organizationId),
    [allChoices, application.organizationId],
  );

  const [domain, setDomain] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [root, setRoot] = useState(false);
  const [path, setPath] = useState("");
  const [stripPrefix, setStripPrefix] = useState(false);
  const [hostBlocked, setHostBlocked] = useState(false);
  const [dnsConsent, setDnsConsent] = useState(false);
  const [adding, setAdding] = useState(false);
  const picked = choices.find((choice) => choice.name === domain);
  const useRoot = root && !!picked && !picked.shared;
  const host = joinHost(subdomain, domain, useRoot);
  const nextPath = path.trim() === "/" ? "" : path.trim();
  const pathProblem = nextPath && !PATH.test(nextPath) ? t("A path is like /api/* — or leave it empty for the whole host") : null;
  const problem = hostnameProblem(subdomain, picked, useRoot);
  const taken = application.domains.some((d) => d.host === host && (d.path ?? "") === nextPath);

  const add = async () => {
    setAdding(true);
    const label = `${host}${nextPath}`;
    try {
      const { dns } = await addAppDomain(application.id, { host, path: nextPath, stripPrefix: !!nextPath && stripPrefix, dnsConsent: dnsConsent || undefined });
      const dnsProblem = ["conflict", "unavailable"].includes(dns.state);
      toast(
        dnsProblem
          ? { variant: "destructive", title: t("{host} added", { host: label }), description: dns.detail }
          : { title: t("{host} added", { host: label }), description: t("It goes to {app}.", { app: application.name }) },
      );
      setSubdomain("");
      setPath("");
      setStripPrefix(false);
      setOpen(false);
      await onAdded();
    } catch (error) {
      toast({ variant: "destructive", title: t("Could not add the route"), description: error instanceof Error ? error.message : "" });
    } finally {
      setAdding(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="mr-2 h-4 w-4" />
        {t("Add route")}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !adding && setOpen(next)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("Add route")}</DialogTitle>
            <DialogDescription>{t("A host, or a path under one, that goes to {app}.", { app: application.name })}</DialogDescription>
          </DialogHeader>
          {isLoading ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <div className="space-y-4">
              <HostnamePicker
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
              />
              {/* optional: a path under the host — other apps of the organization can have the rest */}
              <div className="space-y-2">
                <Input className="font-mono text-sm" value={path} placeholder={t("path (optional), e.g. /api/*")} onChange={(e) => setPath(e.target.value)} />
                {nextPath && (
                  <label className="flex items-center gap-1.5 text-sm" title={t("The app gets the path without this prefix: /api/users arrives as /users.")}>
                    <Checkbox checked={stripPrefix} onCheckedChange={(checked) => setStripPrefix(checked === true)} />
                    {t("strip prefix")}
                  </label>
                )}
                {pathProblem && <p className="text-xs text-destructive">{pathProblem}</p>}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={adding} onClick={() => setOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button
              onClick={() => void add()}
              // a path on a host the organization already serves is not "blocked": the host is shared by path
              disabled={!domain || !!problem || !!pathProblem || (hostBlocked && !nextPath) || adding || taken}
            >
              {adding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              {t("Add route")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
