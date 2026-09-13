import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, Globe, Loader2, ShoppingCart } from "lucide-react";
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
import { type Application, updateApplication } from "@/lib/applications";
import { isAdmin } from "@/lib/auth";
import { getDomainChoices } from "@/lib/domains";
import { t } from "@/lib/i18n";

/**
 * The app's address, and moving it: to a free name under a shared platform
 * domain, or onto one of its organization's own domains. The backend routes
 * the new name before it drops the old one, so the move has no gap.
 */
export function AppDomainsCard({ application }: { application: Application }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: allChoices = [], isLoading } = useQuery({ queryKey: ["domains", "choices"], queryFn: getDomainChoices });
  // a rename keeps the app in its org: shared domains, and that org's own
  const choices = useMemo(
    () => allChoices.filter((choice) => choice.shared || choice.organizationId === application.organizationId),
    [allChoices, application.organizationId],
  );
  const current = allChoices.find((choice) => choice.id === application.domainId);

  const [domain, setDomain] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [root, setRoot] = useState(false);
  const reset = () => {
    setDomain(current?.name ?? "");
    const onRoot = !!current && application.domain === current.name;
    setRoot(onRoot);
    setSubdomain(current && !onRoot ? application.domain.slice(0, -(current.name.length + 1)) : "");
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reset, [current?.id, application.domain]);

  const picked = choices.find((choice) => choice.name === domain);
  const useRoot = root && !!picked && !picked.shared;
  const next = joinHost(subdomain, domain, useRoot);
  const changed = !!domain && next !== application.domain;
  const problem = hostnameProblem(subdomain, picked, useRoot);
  const [confirming, setConfirming] = useState(false);
  const [hostBlocked, setHostBlocked] = useState(false);
  const [dnsConsent, setDnsConsent] = useState(false);
  const [saving, setSaving] = useState(false);

  // values that spell out the address — the app's own URL — do not follow a move
  const staleEnv = Object.entries(application.envVars ?? {})
    .filter(([, value]) => String(value).includes(application.domain))
    .map(([key]) => key);

  const move = async () => {
    setSaving(true);
    try {
      const updated = (await updateApplication(application.id, { domain: next, dnsConsent: dnsConsent || undefined })) as Application & {
        dns?: { state: string; detail: string };
      };
      const dnsProblem = updated.dns && ["conflict", "unavailable"].includes(updated.dns.state);
      toast(
        dnsProblem
          ? { variant: "destructive", title: t("Moved to {host}", { host: next }), description: updated.dns!.detail }
          : { title: t("Moved to {host}", { host: next }), description: t("The old address no longer serves this app.") },
      );
      await queryClient.invalidateQueries({ queryKey: ["application", application.id] });
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
      void queryClient.invalidateQueries({ queryKey: ["domains", "choices"] });
    } catch (error) {
      toast({ variant: "destructive", title: t("Could not move the app"), description: error instanceof Error ? error.message : "" });
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  };

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
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`https://${application.domain}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 font-mono hover:text-primary"
          >
            {application.domain}
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          {current?.shared && <Badge variant="secondary">{t("free")}</Badge>}
          <DomainExpiryBadge domain={application.parentDomain} />
        </div>

        {application.runtime ? (
          <p className="text-sm text-muted-foreground">{t("An imported app keeps its hostname.")}</p>
        ) : isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          <div className="space-y-3">
            <p className="text-sm font-medium">{t("Change address")}</p>
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
              {changed && (
                <Button variant="ghost" onClick={reset} disabled={saving}>
                  {t("Reset")}
                </Button>
              )}
              <Button onClick={() => setConfirming(true)} disabled={!changed || !!problem || hostBlocked || saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t("Move app")}
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      <AlertDialog open={confirming} onOpenChange={(open) => !saving && setConfirming(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Move to {host}?", { host: next })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("{old} stops serving this app once {host} does. Links and bookmarks to the old address break.", {
                old: application.domain,
                host: next,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {staleEnv.length > 0 && (
            <p className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/5 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              {t("{keys} still hold the old address — update them in Environment and redeploy.", {
                keys: staleEnv.join(", "),
              })}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving}
              onClick={(e) => {
                e.preventDefault();
                void move();
              }}
            >
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("Move app")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
