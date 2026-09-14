import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle, ExternalLink, Globe, Loader2, Plus, ShoppingCart, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { type Application, type HostnameHealth, addAppDomain, removeAppDomain } from "@/lib/applications";
import { HostBadge, HostPointing, hostOk } from "@/components/HostCheck";
import { isAdmin } from "@/lib/auth";
import { getDomainChoices } from "@/lib/domains";
import { t } from "@/lib/i18n";

/**
 * The app's hostnames — one or more, all alike — and changing them: add a name
 * (a free one under a shared platform domain, or one of its organization's own
 * domains), or take one off. A new name is routed as the others before it is
 * kept; the last name stays, an app with none is nothing anyone can reach.
 */
export function AppDomainsCard({
  application,
  checks,
  pending,
  onRepoint,
}: {
  application: Application;
  /** the live check of each name, when the page has it */
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
  const picked = choices.find((choice) => choice.name === domain);
  const useRoot = root && !!picked && !picked.shared;
  const next = joinHost(subdomain, domain, useRoot);
  const problem = hostnameProblem(subdomain, picked, useRoot);
  const [hostBlocked, setHostBlocked] = useState(false);
  const [dnsConsent, setDnsConsent] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["application", application.id] });
    void queryClient.invalidateQueries({ queryKey: ["applications"] });
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
    void queryClient.invalidateQueries({ queryKey: ["project"] });
    void queryClient.invalidateQueries({ queryKey: ["domains", "choices"] });
  };

  const add = async () => {
    setAdding(true);
    try {
      const { dns } = await addAppDomain(application.id, next, dnsConsent || undefined);
      const dnsProblem = ["conflict", "unavailable"].includes(dns.state);
      toast(
        dnsProblem
          ? { variant: "destructive", title: t("{host} added", { host: next }), description: dns.detail }
          : { title: t("{host} added", { host: next }), description: t("It serves this app, like its other names.") },
      );
      setSubdomain("");
      await refresh();
    } catch (error) {
      toast({ variant: "destructive", title: t("Could not add the domain"), description: error instanceof Error ? error.message : "" });
    } finally {
      setAdding(false);
    }
  };

  const remove = async (host: string) => {
    setRemoving(host);
    try {
      await removeAppDomain(application.id, host);
      toast({ title: t("{host} removed", { host }), description: t("It no longer serves this app.") });
      await refresh();
    } catch (error) {
      toast({ variant: "destructive", title: t("Could not remove the domain"), description: error instanceof Error ? error.message : "" });
    } finally {
      setRemoving(null);
      setConfirmRemove(null);
    }
  };

  // values that spell out an address — the app's own URL — do not follow a removed name
  const staleEnv = (host: string) =>
    Object.entries(application.envVars ?? {})
      .filter(([, value]) => String(value).includes(host))
      .map(([key]) => key);
  const only = application.domains.length === 1;

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
        {/* every name it answers on, all alike — checked together */}
        <ul className="divide-y divide-border/60 rounded-md border border-border/60">
          {application.domains.map((name) => (
            <li key={name.host} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <a
                href={`https://${name.host}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-w-0 items-center gap-1.5 break-all font-mono text-sm hover:text-primary"
              >
                {name.host}
                <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              </a>
              {name.parentDomain?.shared && <Badge variant="secondary">{t("free")}</Badge>}
              <DomainExpiryBadge domain={name.parentDomain} />
              {/* connected right: a tick, nothing more. Anything else says what is wrong, and how to fix it */}
              <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
                {(() => {
                  const check = checks?.find((c) => c.host === name.host);
                  if (!check) return null;
                  // answers, from this server (or behind Cloudflare's proxy, which hides which)
                  if (hostOk(check)) {
                    return (
                      <span title={t("Points at this server")}>
                        <CheckCircle className="h-4 w-4 text-success" aria-label={t("Points at this server")} />
                      </span>
                    );
                  }
                  return (
                    <>
                      <HostBadge host={name.host} check={check} pending={pending} onRepoint={onRepoint && (() => onRepoint(name.host))} />
                      {check.pointing?.state === "elsewhere" && <HostPointing check={check} />}
                    </>
                  );
                })()}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                disabled={only || !!removing}
                title={only ? t("An app needs at least one hostname — add another first") : t("Remove {host}", { host: name.host })}
                aria-label={t("Remove {host}", { host: name.host })}
                onClick={() => setConfirmRemove(name.host)}
              >
                {removing === name.host ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </Button>
            </li>
          ))}
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
                disabled={!domain || !!problem || hostBlocked || adding || application.domains.some((d) => d.host === next)}
              >
                {adding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                {t("Add domain")}
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      <AlertDialog open={!!confirmRemove} onOpenChange={(open) => !removing && !open && setConfirmRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Remove {host}?", { host: confirmRemove ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("{host} stops serving this app, and its DNS record pointing here is removed. Links and bookmarks to it break.", {
                host: confirmRemove ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmRemove && staleEnv(confirmRemove).length > 0 && (
            <p className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/5 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              {t("{keys} still hold this address — update them in Environment and redeploy.", {
                keys: staleEnv(confirmRemove).join(", "),
              })}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!removing}>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!removing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                if (confirmRemove) void remove(confirmRemove);
              }}
            >
              {removing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("Remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
