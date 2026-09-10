import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Camera,
  Globe,
  HardDrive,
  Loader2,
  RefreshCw,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageLayout } from "@/components/PageLayout";
import { useToast } from "@/hooks/use-toast";
import {
  LogSource,
  getServer,
  getServerApps,
  getServerCaddySites,
  getServerLogs,
  getServerSnapshots,
  pingServer,
  snapshotServerCaddy,
} from "@/lib/servers";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  ONLINE: "default",
  OFFLINE: "destructive",
  UNKNOWN: "secondary",
};

const LOG_SOURCES: Array<{ value: LogSource; label: string }> = [
  { value: "errors", label: "Errors (all units)" },
  { value: "system", label: "System" },
  { value: "caddy", label: "Caddy" },
  { value: "apps", label: "Applications" },
  { value: "php", label: "PHP-FPM" },
  { value: "ssh", label: "SSH" },
];

const when = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "—";

/** Two-column key/value line, the shape every overview row here takes. */
const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-start justify-between gap-3 border-b border-border/60 py-2 text-sm last:border-0">
    <span className="text-muted-foreground">{label}</span>
    <span className="min-w-0 text-right">{children}</span>
  </div>
);

const ServerDetail = () => {
  const { id = "" } = useParams();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [logSource, setLogSource] = useState<LogSource>("errors");

  const { data: server, isLoading } = useQuery({
    queryKey: ["servers", id],
    queryFn: () => getServer(id),
    enabled: !!id,
  });

  const sites = useQuery({
    queryKey: ["servers", id, "caddy-sites"],
    queryFn: () => getServerCaddySites(id),
    enabled: !!id,
    retry: false,
  });

  const apps = useQuery({
    queryKey: ["servers", id, "apps"],
    queryFn: () => getServerApps(id),
    enabled: !!id,
  });

  const snapshots = useQuery({
    queryKey: ["servers", id, "snapshots"],
    queryFn: () => getServerSnapshots(id),
    enabled: !!id,
  });

  const logs = useQuery({
    queryKey: ["servers", id, "logs", logSource],
    queryFn: () => getServerLogs(id, logSource),
    enabled: !!id,
  });

  const ping = useMutation({
    mutationFn: () => pingServer(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      toast({ title: "Checked" });
    },
    onError: (error: Error) =>
      toast({ title: "Check failed", description: error.message, variant: "destructive" }),
  });

  const snapshot = useMutation({
    mutationFn: () => snapshotServerCaddy(id),
    onSuccess: (message) => {
      queryClient.invalidateQueries({ queryKey: ["servers", id, "snapshots"] });
      toast({ title: "Snapshot", description: message });
    },
    onError: (error: Error) =>
      toast({ title: "Snapshot failed", description: error.message, variant: "destructive" }),
  });

  if (isLoading || !server) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <PageLayout
      title={server.name}
      backTo="/servers"
      icon={HardDrive}
      description={`${server.sshUser}@${server.hostname}:${server.sshPort}`}
      actions={
        <div className="flex gap-2">
          <Button variant="outline" disabled={ping.isPending} onClick={() => ping.mutate()}>
            {ping.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Check now
          </Button>
          <Button variant="outline" disabled={snapshot.isPending} onClick={() => snapshot.mutate()}>
            <Camera className="mr-2 h-4 w-4" />
            Snapshot Caddy
          </Button>
        </div>
      }
    >
      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="sites">Caddy sites</TabsTrigger>
          <TabsTrigger value="apps">Applications</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="snapshots">Snapshots</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Node</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <Row label="Status">
                  <Badge variant={STATUS_VARIANT[server.status] ?? "secondary"}>
                    {server.status}
                  </Badge>
                </Row>
                <Row label="Last seen">{when(server.lastSeenAt)}</Row>
                <Row label="Public IP">
                  <span className="font-mono text-xs">{server.publicIp}</span>
                </Row>
                <Row label="Authentication">
                  {server.authMethod === "PASSWORD" ? "password" : "SSH key"}
                </Row>
                <Row label="Key path">
                  <span className="font-mono text-xs">{server.sshKeyPath ?? "—"}</span>
                </Row>
                <Row label="Tags">
                  {server.tags?.length ? (
                    <span className="flex flex-wrap justify-end gap-1">
                      {server.tags.map((tag) => (
                        <Badge key={tag} variant="outline">
                          {tag}
                        </Badge>
                      ))}
                    </span>
                  ) : (
                    "—"
                  )}
                </Row>
                {server.lastError && (
                  <Row label="Last error">
                    <span className="text-xs text-destructive">{server.lastError}</span>
                  </Row>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  Organizations ({server.organizations?.length ?? 0})
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {server.organizations?.length ? (
                  server.organizations.map((org) => (
                    <Row key={org.id} label={org.name}>
                      <span className="font-mono text-xs">{org.slug}</span>
                    </Row>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Nothing placed here yet. Apps deploy to the node their organization sits on.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* what Caddy is serving right now, read live over SSH */}
        <TabsContent value="sites">
          <Card>
            <CardContent className="pt-6">
              {sites.isLoading ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : sites.error ? (
                <p className="flex items-center gap-2 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  {(sites.error as Error).message}
                </p>
              ) : sites.data?.length ? (
                <div className="space-y-1">
                  {sites.data.map((site) => (
                    <div
                      key={site.host}
                      className="flex items-center justify-between gap-3 border-b border-border/60 py-2 text-sm last:border-0"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate font-medium">{site.host}</span>
                        {!site.managed && (
                          <Badge variant="secondary" className="shrink-0">
                            infrastructure
                          </Badge>
                        )}
                      </span>
                      <span className="shrink-0 text-right text-xs text-muted-foreground">
                        <Badge variant="outline" className="mr-2">
                          {site.kind.toLowerCase()}
                        </Badge>
                        {site.port
                          ? `localhost:${site.port}`
                          : site.socket || site.origin || site.rootPath || ""}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Caddy is serving nothing here.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="apps">
          <Card>
            <CardContent className="pt-6">
              {apps.isLoading ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : apps.data?.length ? (
                <div className="space-y-1">
                  {apps.data.map((app) => (
                    <div
                      key={app.id}
                      className="flex items-center justify-between gap-3 border-b border-border/60 py-2 text-sm last:border-0"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{app.domain}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {app.organization?.name ?? "Unassigned"} · {app.type.toLowerCase()}
                          {app.port ? ` · :${app.port}` : ""}
                        </span>
                      </span>
                      <Badge variant={app.status === "RUNNING" ? "default" : "secondary"}>
                        {app.status.toLowerCase()}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No applications on this node yet.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="logs" className="space-y-3">
          <div className="flex items-center gap-2">
            <Select value={logSource} onValueChange={(value) => setLogSource(value as LogSource)}>
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOG_SOURCES.map((source) => (
                  <SelectItem key={source.value} value={source.value}>
                    {source.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => logs.refetch()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
            {logs.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>

          <pre className="max-h-[60vh] overflow-auto rounded-md border border-border/60 bg-muted/30 p-3 text-xs leading-relaxed">
            {logs.data?.output ?? (logs.error as Error)?.message ?? "…"}
          </pre>
        </TabsContent>

        <TabsContent value="snapshots">
          <Card>
            <CardContent className="pt-6">
              <p className="mb-3 text-xs text-muted-foreground">
                Caddy holds its routes in memory. These are the copies the platform keeps, so
                a reload cannot lose the sites on this node.
              </p>
              {snapshots.isLoading ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : snapshots.data?.length ? (
                snapshots.data.map((snap) => (
                  <Row key={snap.id} label={new Date(snap.createdAt).toLocaleString()}>
                    <span className="text-xs text-muted-foreground">
                      {snap.hosts.length} route{snap.hosts.length === 1 ? "" : "s"}
                    </span>
                  </Row>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  No snapshot yet — take one before anything reloads Caddy on this box.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </PageLayout>
  );
};

export default ServerDetail;
