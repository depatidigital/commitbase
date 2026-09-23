import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertCircle, Box, Download, Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { t } from "@/lib/i18n";
import { getDockerContainers, importDockerContainer } from "@/lib/servers";

/**
 * The node's running docker containers, each published port with the hostnames
 * nginx or Caddy send to it, and the panel app on it if there is one. Importing
 * only records the app — the container stays docker's.
 */
export function DockerContainersCard({ serverId }: { serverId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const containers = useQuery({
    queryKey: ["servers", serverId, "docker"],
    queryFn: () => getDockerContainers(serverId),
    retry: false,
  });

  const adopt = useMutation({
    mutationFn: ({ name, port }: { name: string; port: number }) => importDockerContainer(serverId, name, port),
    onSuccess: (result, { name, port }) => {
      queryClient.invalidateQueries({ queryKey: ["servers", serverId] });
      toast({
        title: result.created ? t("Imported {name}", { name: `${name}:${port}` }) : t("Linked {name}", { name: `${name}:${port}` }),
        description: result.skippedHosts.length
          ? t("Kept with their current service: {hosts}", { hosts: result.skippedHosts.join(", ") })
          : undefined,
      });
    },
    onError: (error: Error) => toast({ title: t("Import failed"), description: error.message, variant: "destructive" }),
  });

  if (containers.isLoading) {
    return (
      <Card>
        <CardContent className="pt-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (containers.error) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {(containers.error as Error).message}
          </p>
        </CardContent>
      </Card>
    );
  }

  const list = containers.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {t("Importing records the container's port as a service, with the hostnames already sent to it. The container keeps running under docker, untouched.")}
        </p>
        <Button variant="outline" size="sm" onClick={() => containers.refetch()} disabled={containers.isFetching}>
          <RefreshCw className={`mr-2 h-4 w-4 ${containers.isFetching ? "animate-spin" : ""}`} />
          {t("Re-read")}
        </Button>
      </div>

      <Card>
        <CardContent className="space-y-1 pt-6">
          {list.length === 0 && <p className="text-sm text-muted-foreground">{t("No running docker containers on this node.")}</p>}
          {list.map((container) => (
            <div key={container.name} className="space-y-2 border-b border-border/60 py-3 text-sm last:border-0">
              <div className="flex flex-wrap items-center gap-2">
                <Box className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="font-medium">{container.name}</span>
                <span className="truncate text-xs text-muted-foreground">{container.image}</span>
                <Badge variant="outline" className="text-xs">
                  {container.status}
                </Badge>
              </div>

              {container.maps.length === 0 && (
                <p className="pl-6 text-xs text-muted-foreground">{t("Publishes no port on the host — nothing to route to.")}</p>
              )}

              {container.maps.map((map) => {
                const hosts = [
                  ...map.caddyHosts.map((host) => ({ host, via: "Caddy" })),
                  ...map.nginxHosts.filter((host) => !map.caddyHosts.includes(host)).map((host) => ({ host, via: "nginx" })),
                ];
                const busy = adopt.isPending && adopt.variables?.name === container.name && adopt.variables?.port === map.port;
                const linked = map.app?.runtime === "DOCKER";
                return (
                  <div key={map.port} className="flex flex-wrap items-center justify-between gap-2 pl-6">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <code className="text-xs">:{map.port}</code>
                      <span className="text-xs text-muted-foreground">→</span>
                      {hosts.length ? (
                        hosts.map(({ host, via }) => (
                          <Badge key={host} variant="secondary" className="gap-1 text-xs font-normal">
                            {host}
                            <span className="text-muted-foreground">{via}</span>
                          </Badge>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground">{t("no hostname routes here")}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {map.app && (
                        <Link to={`/services/${map.app.id}`} className="text-xs text-primary hover:underline">
                          {map.app.name}
                        </Link>
                      )}
                      {!linked && (
                        <Button size="sm" variant="outline" disabled={adopt.isPending} onClick={() => adopt.mutate({ name: container.name, port: map.port })}>
                          {busy ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-2 h-3.5 w-3.5" />}
                          {map.app ? t("Link") : t("Import")}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
