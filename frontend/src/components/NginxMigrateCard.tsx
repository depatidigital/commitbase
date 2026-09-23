import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowRight, Check, Globe, Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { useToast } from "@/hooks/use-toast";
import { t } from "@/lib/i18n";
import { getNginxPlan, migrateNginx, setupServer, type NginxSitePlan } from "@/lib/servers";

/** What each site becomes, in one line. */
const becomes = (plan: NginxSitePlan): string => {
  const { site } = plan;
  if (site.kind === "proxy") return t("reverse proxy to localhost:{port}", { port: String(site.port ?? "?") });
  if (site.kind === "php") return t("PHP files in {root}", { root: site.root ?? "?" });
  if (site.kind === "static") return site.spa ? t("static files in {root}, single-page fallback", { root: site.root ?? "?" }) : t("static files in {root}", { root: site.root ?? "?" });
  return t("not recognised");
};

/** The behaviour carried over, which is the part worth showing. */
const kept = (plan: NginxSitePlan): string[] => {
  const out: string[] = [];
  if (plan.site.maxBodyBytes) out.push(t("uploads up to {mb} MB", { mb: String(Math.round(plan.site.maxBodyBytes / 1024 / 1024)) }));
  if (plan.site.readTimeout) out.push(t("waits {timeout} for the app", { timeout: plan.site.readTimeout }));
  if (plan.site.streaming) out.push(t("streams the response"));
  if (plan.site.deny?.length) out.push(t("{n} denied path(s) stay 403", { n: String(plan.site.deny.length) }));
  return out;
};

/**
 * Adopting a node that still serves its sites with nginx. Reading is safe and
 * repeatable; switching is one confirmed step that puts nginx back by itself if
 * any hostname stops answering.
 */
export function NginxMigrateCard({ serverId }: { serverId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);

  const install = useMutation({
    mutationFn: () => setupServer(serverId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["servers", serverId] });
      toast({ title: t("Setup queued"), description: t("Caddy is installed stopped; nginx keeps serving. Re-read this tab when setup is done.") });
    },
    onError: (error: Error) => toast({ title: t("Setup failed"), description: error.message, variant: "destructive" }),
  });

  const plan = useQuery({
    queryKey: ["servers", serverId, "nginx"],
    queryFn: () => getNginxPlan(serverId),
    retry: false,
  });

  const migrate = useMutation({
    mutationFn: () => migrateNginx(serverId),
    onSuccess: (result) => {
      setConfirm(false);
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      toast({ title: t("Migrated to Caddy"), description: result.message });
    },
    onError: (error: Error) => {
      setConfirm(false);
      // a rollback arrives here too: the box is still serving, which the message says
      toast({ title: t("Not migrated"), description: error.message, variant: "destructive" });
    },
  });

  if (plan.isLoading) {
    return (
      <Card>
        <CardContent className="pt-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (plan.error) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {(plan.error as Error).message}
          </p>
        </CardContent>
      </Card>
    );
  }

  const sites = plan.data?.sites ?? [];
  const blocked = sites.filter((site) => site.blocked);
  const dangling = sites.flatMap((site) => site.danglingHosts);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {sites.length
            ? t("{n} site(s) in {files} nginx file(s).", { n: String(sites.length), files: String(plan.data?.files.length ?? 0) })
            : t("No nginx sites found on this node.")}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => plan.refetch()} disabled={plan.isFetching}>
            <RefreshCw className={`mr-2 h-4 w-4 ${plan.isFetching ? "animate-spin" : ""}`} />
            {t("Re-read")}
          </Button>
          <Button size="sm" onClick={() => setConfirm(true)} disabled={!plan.data?.ready || migrate.isPending}>
            {migrate.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRight className="mr-2 h-4 w-4" />}
            {t("Migrate to Caddy")}
          </Button>
        </div>
      </div>

      {plan.data && !plan.data.caddyInstalled && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 p-3">
          <p className="flex items-start gap-2 text-sm text-warning">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {t("Caddy is not installed on this node. Set up installs it without starting it, so nginx keeps serving until you migrate.")}
          </p>
          <Button size="sm" variant="outline" onClick={() => install.mutate()} disabled={install.isPending}>
            {install.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("Install Caddy (Set up)")}
          </Button>
        </div>
      )}

      {blocked.length > 0 && (
        <p className="flex items-start gap-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {t("{n} site(s) cannot be migrated. Migrating is blocked until they are resolved, because they would go dark after the switch.", {
            n: String(blocked.length),
          })}
        </p>
      )}

      {dangling.length > 0 && (
        <p className="flex items-start gap-2 text-sm text-warning">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {t("{n} hostname(s) do not resolve to this node. Caddy asks for a certificate per hostname, so those will keep failing until their DNS points here: {hosts}", {
            n: String(dangling.length),
            hosts: dangling.join(", "),
          })}
        </p>
      )}

      <Card>
        <CardContent className="space-y-1 pt-6">
          {sites.length === 0 && <p className="text-sm text-muted-foreground">{t("Nothing to migrate.")}</p>}
          {sites.map((site, index) => (
            <div key={index} className="space-y-1 border-b border-border/60 py-3 text-sm last:border-0">
              <div className="flex flex-wrap items-center gap-2">
                <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="font-medium">{site.site.hosts.join(", ")}</span>
                {site.blocked ? (
                  <Badge variant="outline" className="border-destructive text-destructive">
                    {t("blocked")}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="gap-1">
                    <Check className="h-3 w-3" />
                    {site.site.kind}
                  </Badge>
                )}
                {site.route !== undefined && (
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => setPreview(preview === index ? null : index)}
                  >
                    {preview === index ? t("Hide Caddy route") : t("Preview Caddy route")}
                  </button>
                )}
              </div>
              {preview === index && (
                <pre className="ml-6 max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(site.route, null, 2)}</pre>
              )}
              <p className="pl-6 text-xs text-muted-foreground">{site.blocked ?? becomes(site)}</p>
              {kept(site).length > 0 && (
                <p className="pl-6 text-xs text-muted-foreground">{t("kept:")} {kept(site).join(" · ")}</p>
              )}
              {site.site.warnings.map((warning) => (
                <p key={warning} className="pl-6 text-xs text-warning">
                  {warning}
                </p>
              ))}
              {!!site.proxiedHosts?.length && (
                <p className="pl-6 text-xs text-muted-foreground">
                  {t("via Cloudflare proxy:")} {site.proxiedHosts.join(", ")}
                </p>
              )}
              {site.danglingHosts.length > 0 && (
                <p className="pl-6 text-xs text-warning">
                  {t("does not resolve here:")} {site.danglingHosts.join(", ")}
                </p>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Switch this node to Caddy?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "nginx is stopped, Caddy starts with every site above loaded at once, and each hostname is checked. If any does not answer, nginx is started again and nothing has changed. Its configuration files are never edited or removed, so the way back is always `systemctl enable --now nginx`. Certificates are not copied from nginx: Caddy gets its own, so expect up to two minutes where HTTPS is not reachable. Each hostname must then answer over HTTPS with a valid certificate, and no worse than it did under nginx, or the switch is undone.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => migrate.mutate()}>{t("Switch over")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
