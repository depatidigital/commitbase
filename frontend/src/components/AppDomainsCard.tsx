import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle, ExternalLink, Globe, Loader2, Plus, ShoppingCart, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
import { DomainExpiryBadge } from "@/components/DomainExpiryBadge";
import { useToast } from "@/hooks/use-toast";
import {
  type AppDomain,
  type Application,
  type HostnameHealth,
  addAppDomain,
  bindingLabel,
  removeAppDomain,
  setBindingStripPrefix,
} from "@/lib/applications";
import { HostBadge, HostPointing, hostOk } from "@/components/HostCheck";
import { isAdmin } from "@/lib/auth";
import { getDomainChoices } from "@/lib/domains";
import { t } from "@/lib/i18n";

/** A path as someone types it: "" for the whole name, else `/api/*`-like. */
const PATH = /^\/[A-Za-z0-9._~\-/]*\*?$/;

/**
 * Where the app answers — hostnames, or a path under one (`app.example.com/api/*`)
 * — all alike, and changing them: add one (a free name under a shared platform
 * domain, one of its organization's own, or a path on a name the organization
 * already serves), take one off. The name's route is composed again with every
 * app on it; the last binding stays, an app with none is nothing anyone can reach.
 */
export function AppDomainsCard({
  application,
  checks,
  pending,
  onRepoint,
}: {
  application: Application;
  /** the live check of each binding, when the page has it */
  checks?: HostnameHealth[];
  pending?: boolean;
  onRepoint?: (host: string) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: allChoices = [], isLoading } = useQuery({ queryKey: ["domains", "choices"], queryFn: getDomainChoices });
  // a name keeps the app in its org: shared domains, and that org's own
  const choices = useMemo(
    () => allChoices.filter((choice) => choice.shared || choice.organizationId === application.organizationId),
    [allChoices, application.organizationId],
  );

  const [domain, setDomain] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [root, setRoot] = useState(false);
  const [path, setPath] = useState("");
  const [stripPrefix, setStripPrefix] = useState(false);
  const picked = choices.find((choice) => choice.name === domain);
  const useRoot = root && !!picked && !picked.shared;
  const next = joinHost(subdomain, domain, useRoot);
  const nextPath = path.trim() === "/" ? "" : path.trim();
  const pathProblem = nextPath && !PATH.test(nextPath) ? t("A path is like /api/* — or leave it empty for the whole name") : null;
  const problem = hostnameProblem(subdomain, picked, useRoot);
  const [hostBlocked, setHostBlocked] = useState(false);
  const [dnsConsent, setDnsConsent] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<AppDomain | null>(null);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["application", application.id] });
    void queryClient.invalidateQueries({ queryKey: ["applications"] });
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
    void queryClient.invalidateQueries({ queryKey: ["project"] });
    void queryClient.invalidateQueries({ queryKey: ["domains", "choices"] });
  };

  const add = async () => {
    setAdding(true);
    const label = `${next}${nextPath}`;
    try {
      const { dns } = await addAppDomain(application.id, {
        host: next,
        path: nextPath,
        stripPrefix: !!nextPath && stripPrefix,
        dnsConsent: dnsConsent || undefined,
      });
      const dnsProblem = ["conflict", "unavailable"].includes(dns.state);
      toast(
        dnsProblem
          ? { variant: "destructive", title: t("{host} added", { host: label }), description: dns.detail }
          : { title: t("{host} added", { host: label }), description: t("It serves this app, like its other names.") },
      );
      setSubdomain("");
      setPath("");
      setStripPrefix(false);
      await refresh();
    } catch (error) {
      toast({ variant: "destructive", title: t("Could not add the domain"), description: error instanceof Error ? error.message : "" });
    } finally {
      setAdding(false);
    }
  };

  const remove = async (binding: AppDomain) => {
    const label = bindingLabel(binding);
    setBusy(label);
    try {
      await removeAppDomain(application.id, binding.host, binding.path ?? "");
      toast({ title: t("{host} removed", { host: label }), description: t("It no longer serves this app.") });
      await refresh();
    } catch (error) {
      toast({ variant: "destructive", title: t("Could not remove the domain"), description: error instanceof Error ? error.message : "" });
    } finally {
      setBusy(null);
      setConfirmRemove(null);
    }
  };

  const toggleStrip = async (binding: AppDomain, strip: boolean) => {
    const label = bindingLabel(binding);
    setBusy(label);
    try {
      await setBindingStripPrefix(application.id, binding.host, binding.path ?? "", strip);
      await refresh();
    } catch (error) {
      toast({ variant: "destructive", title: t("Could not change the binding"), description: error instanceof Error ? error.message : "" });
    } finally {
      setBusy(null);
    }
  };

  // values that spell out an address — the app's own URL — do not follow a removed name
  const staleEnv = (host: string) =>
    Object.entries(application.envVars ?? {})
      .filter(([, value]) => String(value).includes(host))
      .map(([key]) => key);
  const only = application.domains.length === 1;
  const taken = application.domains.some((d) => d.host === next && (d.path ?? "") === nextPath);

  return (
    <Card className="bg-gradient-card border-border/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-5 w-5 text-primary" />
          {t("Domains")}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{t("Where visitors reach this app")}</p>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* every binding, all alike — each checked at its own path */}
        <ul className="divide-y divide-border/60 rounded-md border border-border/60">
          {application.domains.map((name) => {
            const label = bindingLabel(name);
            const check = checks?.find((c) => c.host === name.host && (c.path ?? "") === (name.path ?? ""));
            return (
              <li key={label} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <a
                  href={`https://${name.host}${name.path ? name.path.replace(/\*+$/, "") : ""}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-w-0 items-center gap-1.5 break-all font-mono text-sm hover:text-primary"
                >
                  {name.host}
                  {name.path && <span className="text-muted-foreground">{name.path}</span>}
                  <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                </a>
                {name.parentDomain?.shared && <Badge variant="secondary">{t("free")}</Badge>}
                <DomainExpiryBadge domain={name.parentDomain} />
                {/* a path: whether the app gets /api/users, or /users */}
                {name.path && (
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title={t("The app gets the path without this prefix: /api/users arrives as /users.")}>
                    <Checkbox checked={!!name.stripPrefix} disabled={busy === label} onCheckedChange={(checked) => void toggleStrip(name, checked === true)} />
                    {t("strip prefix")}
                  </label>
                )}
                {/* connected right: a tick, nothing more. Anything else says what is wrong, and how to fix it */}
                <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
                  {check &&
                    (hostOk(check) ? (
                      <span title={t("Points at this server")}>
                        <CheckCircle className="h-4 w-4 text-success" aria-label={t("Points at this server")} />
                      </span>
                    ) : (
                      <>
                        <HostBadge host={name.host} check={check} pending={pending} onRepoint={onRepoint && (() => onRepoint(name.host))} />
                        {check.pointing?.state === "elsewhere" && <HostPointing check={check} />}
                      </>
                    ))}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                  disabled={only || !!busy}
                  title={only ? t("An app needs at least one hostname — add another first") : t("Remove {host}", { host: label })}
                  aria-label={t("Remove {host}", { host: label })}
                  onClick={() => setConfirmRemove(name)}
                >
                  {busy === label ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </Button>
              </li>
            );
          })}
        </ul>

        {isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          <div className="space-y-3">
            <p className="text-sm font-medium">{t("Add a domain")}</p>
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
            {/* optional: a path under the name — the organization's other apps can have the rest */}
            <div className="flex flex-wrap items-center gap-3">
              <Input
                className="w-56 font-mono text-sm"
                value={path}
                placeholder={t("path (optional), e.g. /api/*")}
                onChange={(e) => setPath(e.target.value)}
              />
              {nextPath && (
                <label className="flex items-center gap-1.5 text-sm" title={t("The app gets the path without this prefix: /api/users arrives as /users.")}>
                  <Checkbox checked={stripPrefix} onCheckedChange={(checked) => setStripPrefix(checked === true)} />
                  {t("strip prefix")}
                </label>
              )}
              {pathProblem && <span className="text-xs text-destructive">{pathProblem}</span>}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {isAdmin() && (
                <Button asChild variant="ghost" className="mr-auto">
                  <Link to="/domains/register">
                    <ShoppingCart className="mr-2 h-4 w-4" />
                    {t("Buy a domain")}
                  </Link>
                </Button>
              )}
              <Button
                onClick={() => void add()}
                // a path on a name the organization already serves is not "taken": the name is shared by path
                disabled={!domain || !!problem || !!pathProblem || (hostBlocked && !nextPath) || adding || taken}
              >
                {adding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                {t("Add domain")}
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      <AlertDialog open={!!confirmRemove} onOpenChange={(open) => !busy && !open && setConfirmRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Remove {host}?", { host: confirmRemove ? bindingLabel(confirmRemove) : "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("{host} stops serving this app, and its DNS record pointing here is removed. Links and bookmarks to it break.", {
                host: confirmRemove ? bindingLabel(confirmRemove) : "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmRemove && staleEnv(confirmRemove.host).length > 0 && (
            <p className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/5 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              {t("{keys} still hold this address — update them in Environment and redeploy.", {
                keys: staleEnv(confirmRemove.host).join(", "),
              })}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busy}>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                if (confirmRemove) void remove(confirmRemove);
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
