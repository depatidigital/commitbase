import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Box, Hammer, Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getStackServices } from "@/lib/applications";
import { t } from "@/lib/i18n";

/**
 * What a compose stack defines — every service, built or pulled, what it
 * publishes and waits on — read on the node from the saved compose files.
 * Picking one fills the service and port Caddy proxies to.
 */
export function ComposePreview({
  applicationId,
  selected,
  onPick,
}: {
  applicationId: string;
  selected: string;
  onPick: (service: string, port: string) => void;
}) {
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["application", applicationId, "compose-services"],
    queryFn: () => getStackServices(applicationId),
    retry: false,
    staleTime: 60_000,
  });

  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t("Services in the stack")}</span>
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2" disabled={isFetching} onClick={() => void refetch()}>
          {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
      </div>
      {error ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="break-all">{(error as Error).message}</span>
        </p>
      ) : !data ? (
        <p className="text-xs text-muted-foreground">{t("Reading the compose files…")}</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {data.map((service) => {
            // the container side of the first published port: what Caddy should dial
            const port = service.ports[0]?.split(":").pop() ?? "";
            return (
              <li key={service.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-xs">
                <span className="min-w-24 font-mono font-medium">{service.name}</span>
                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground">
                  {service.build ? <Hammer className="h-3 w-3 shrink-0" /> : <Box className="h-3 w-3 shrink-0" />}
                  <span className="truncate font-mono">{service.build ? t("built from the repository") : service.image}</span>
                </span>
                {service.ports.map((p) => (
                  <Badge key={p} variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
                    {p}
                  </Badge>
                ))}
                {service.dependsOn.length > 0 && (
                  <span className="text-muted-foreground">{t("needs {services}", { services: service.dependsOn.join(", ") })}</span>
                )}
                {selected === service.name ? (
                  <Badge className="px-1.5 py-0 text-[10px]">{t("Serves traffic")}</Badge>
                ) : (
                  <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => onPick(service.name, port)}>
                    {t("Use this")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[11px] text-muted-foreground">{t("From the saved compose files — save a change to them to see it here.")}</p>
    </div>
  );
}
