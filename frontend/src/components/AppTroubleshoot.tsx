import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Globe, Loader2, Lock, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { fixApplicationHttps, setupApplicationDns } from "@/lib/applications";
import { t } from "@/lib/i18n";
import type { ProjectApp } from "@/lib/projects";

/**
 * Repairs that do not need a redeploy, one service each: its DNS records back
 * on the server (Cloudflare proxy on), and HTTPS (Caddy on :443, certificates).
 * ponytail: two fixes, the ones seen failing; add a row per new kind of breakage.
 */
export function AppTroubleshoot({ app, title }: { app: ProjectApp; title?: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const hosts = [...new Set(app.domains.map((d) => d.host))];
  const checked = () => void queryClient.invalidateQueries({ queryKey: ["application", app.id] });

  // each name on its own: one in a zone we do not run must not stop the others
  const dns = useMutation({
    mutationFn: () => Promise.allSettled(hosts.map((host) => setupApplicationDns(app.id, host))),
    onSuccess: (results) => {
      checked();
      const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${hosts[i]}: ${(r.reason as Error).message}`] : []));
      toast(
        failed.length
          ? { variant: "destructive", title: t("DNS not fixed for every hostname"), description: failed.join("\n") }
          : { title: t("DNS fixed"), description: t("Every hostname points at the server, behind the Cloudflare proxy.") },
      );
    },
  });
  const https = useMutation({
    mutationFn: () => fixApplicationHttps(app.id),
    onSuccess: () => {
      checked();
      toast({ title: t("Fixing HTTPS"), description: t("Takes a few minutes. The outcome is in Logs.") });
    },
    onError: (error: Error) => toast({ variant: "destructive", title: t("Could not start"), description: error.message }),
  });

  const row = (icon: JSX.Element, label: string, detail: string, action: JSX.Element) => (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 py-3 last:border-0">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        {icon}
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{detail}</p>
        </div>
      </div>
      {action}
    </div>
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Wrench className="h-4 w-4 text-primary" />
          {title ?? t("Fix without redeploying")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {hosts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("This service has no hostname, so there is nothing to fix here.")}</p>
        ) : (
          <>
            {row(
              <Globe className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />,
              t("DNS"),
              t("Points {hosts} at the server and turns the Cloudflare proxy on. A record aimed elsewhere is left alone — repoint it from the host.", { hosts: hosts.join(", ") }),
              <Button variant="outline" size="sm" disabled={dns.isPending} onClick={() => dns.mutate()}>
                {dns.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t("Fix DNS")}
              </Button>,
            )}
            {row(
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />,
              t("HTTPS"),
              t("For a site that opens over HTTP only, or shows Cloudflare 521/525: Caddy listens on 443, then each hostname without a certificate gets one (proxy off, Caddy restarted, proxy back on). Every site on the server blinks for a few seconds."),
              <Button variant="outline" size="sm" disabled={https.isPending} onClick={() => https.mutate()}>
                {https.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t("Fix HTTPS")}
              </Button>,
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
