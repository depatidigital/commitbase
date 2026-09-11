import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { OrganizationCombobox } from "@/components/OrganizationCombobox";
import { useToast } from "@/hooks/use-toast";
import { locale, t } from "@/lib/i18n";
import {
  ENGINE_LABEL,
  type DatabaseLogin,
  type ServerDatabase,
  assignServerDatabase,
  getDatabaseServer,
  getDatabaseServerInventory,
  syncDatabaseServer,
  testDatabaseServer,
} from "@/lib/databaseServers";

const size = (bytes: number | null) => {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString(locale, { maximumFractionDigits: unit < 2 ? 0 : 1 })} ${units[unit]}`;
};

/** A database server's page: what is on it, who can reach what, and who owns each database. */
export default function DatabaseServerDetail() {
  const { id = "" } = useParams();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const databaseQuery = useTableQuery(25);
  const loginQuery = useTableQuery(25);

  const { data: server } = useQuery({ queryKey: ["database-servers", id], queryFn: () => getDatabaseServer(id) });
  const { data: inventory, isLoading } = useQuery({
    queryKey: ["database-servers", id, "inventory"],
    queryFn: () => getDatabaseServerInventory(id),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["database-servers", id] });
  const fail = (error: Error) => toast({ title: t("Error"), description: error.message, variant: "destructive" });

  const syncMutation = useMutation({
    mutationFn: () => syncDatabaseServer(id),
    onSuccess: (message) => {
      refresh();
      toast({ title: t("Synced"), description: message });
    },
    onError: fail,
  });

  const testMutation = useMutation({
    mutationFn: () => testDatabaseServer(id),
    onSuccess: ({ ok, message }) => {
      refresh();
      toast({ title: ok ? t("Online") : t("Offline"), description: message, variant: ok ? undefined : "destructive" });
    },
    onError: fail,
  });

  const assignMutation = useMutation({
    mutationFn: ({ databaseId, organizationId }: { databaseId: string; organizationId: string | null }) =>
      assignServerDatabase(id, databaseId, organizationId),
    onSuccess: () => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ["databases"] });
      toast({ title: t("Saved") });
    },
    onError: fail,
  });

  const users = inventory?.users ?? [];

  // who can reach each database, from the logins' side of the mirror
  const reachBy = useMemo(() => {
    const map = new Map<string, DatabaseLogin[]>();
    for (const user of users) {
      if (user.superuser) continue;
      for (const name of user.databases) map.set(name, [...(map.get(name) ?? []), user]);
    }
    return map;
  }, [users]);

  const login = (user: Pick<DatabaseLogin, "username" | "host">) =>
    user.host ? `${user.username}@${user.host}` : user.username;

  const databaseColumns: Column<ServerDatabase>[] = [
    {
      header: t("Database"),
      className: "w-[26%]",
      cell: (row) => (
        <div className="min-w-0">
          <span className="block truncate font-mono text-sm">{row.dbName ?? row.name}</span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {row.discovered ? t("found on the server") : t("created by the panel")}
            {row.status === "ERROR" && (
              <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
                {t("missing from the server")}
              </Badge>
            )}
          </span>
        </div>
      ),
    },
    { header: t("Size"), className: "w-24", cell: (row) => <span className="text-sm">{size(row.sizeBytes)}</span> },
    {
      header: t("Logins with access"),
      className: "w-[26%]",
      cell: (row) => {
        const reach = reachBy.get(row.dbName ?? row.name) ?? [];
        return reach.length ? (
          <div className="flex flex-wrap gap-1">
            {reach.map((user) => (
              <Badge key={user.id} variant="outline" className="font-mono text-xs">
                {login(user)}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground" title={t("Only superusers can reach it.")}>
            —
          </span>
        );
      },
    },
    {
      header: t("Organization"),
      className: "w-[24%]",
      cell: (row) => (
        <OrganizationCombobox
          value={row.organization?.id ?? null}
          onChange={(organizationId) => assignMutation.mutate({ databaseId: row.id, organizationId })}
          noneLabel={t("Unassigned")}
          disabled={assignMutation.isPending}
          className="h-8 w-full"
        />
      ),
    },
    {
      header: t("App"),
      className: "w-32",
      cell: (row) =>
        row.application ? (
          <span className="block truncate text-sm">{row.application.name}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
  ];

  const loginColumns: Column<DatabaseLogin>[] = [
    {
      header: t("Login"),
      className: "w-[30%]",
      cell: (user) => <span className="block truncate font-mono text-sm">{login(user)}</span>,
    },
    {
      header: t("Access"),
      className: "w-40",
      cell: (user) => (
        <div className="flex flex-wrap gap-1">
          {user.superuser && (
            <Badge variant="outline" className="gap-1 border-warning/40 text-xs text-warning">
              <ShieldAlert className="h-3 w-3" />
              {t("superuser")}
            </Badge>
          )}
          {!user.canLogin && (
            <Badge variant="secondary" className="text-xs">
              {t("cannot log in")}
            </Badge>
          )}
        </div>
      ),
    },
    {
      header: t("Databases"),
      cell: (user) =>
        user.superuser ? (
          <span className="text-xs text-muted-foreground">{t("all databases")}</span>
        ) : user.databases.length ? (
          <span className="block truncate font-mono text-xs" title={user.databases.join(", ")}>
            {user.databases.join(", ")}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
  ];

  return (
    <PageLayout
      icon={Database}
      backTo="/database-servers"
      title={server?.name ?? "…"}
      description={server ? `${server.version ?? ENGINE_LABEL[server.engine]} · ${server.adminUser}@${server.host}:${server.port}` : undefined}
      actions={
        <>
          <Button variant="outline" onClick={() => testMutation.mutate()} disabled={testMutation.isPending}>
            {testMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("Test connection")}
          </Button>
          <Button onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending}>
            {syncMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            {syncMutation.isPending ? t("Syncing…") : t("Sync now")}
          </Button>
        </>
      }
    >
      {server && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4 text-sm">
            <Badge variant={server.status === "ONLINE" ? "default" : server.status === "OFFLINE" ? "destructive" : "secondary"}>
              {server.status === "ONLINE" ? t("Online") : server.status === "OFFLINE" ? t("Offline") : t("Unknown")}
            </Badge>
            <span className="text-muted-foreground">
              {server.mode === "TUNNEL"
                ? t("Tunnel via {node}", { node: server.server?.name ?? "—" })
                : t("Direct · TLS {mode}", { mode: server.tlsMode.toLowerCase() })}
            </span>
            <span className="text-muted-foreground">
              {t("Apps connect to {host}", { host: `${server.appHost}:${server.port}` })}
            </span>
            {server.lastSeenAt && (
              <span className="text-muted-foreground">
                {t("Last checked {date}", { date: new Date(server.lastSeenAt).toLocaleString(locale) })}
              </span>
            )}
            {server.lastError && <span className="w-full text-xs text-destructive">{server.lastError}</span>}
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="databases">
        <TabsList>
          <TabsTrigger value="databases">
            {t("Databases")} ({inventory?.databases.length ?? 0})
          </TabsTrigger>
          <TabsTrigger value="logins">
            {t("Logins")} ({users.length})
          </TabsTrigger>
        </TabsList>
        <TabsContent value="databases">
          <DataTable
            columns={databaseColumns}
            rows={inventory?.databases ?? []}
            rowKey={(row) => row.id}
            query={databaseQuery}
            filter={(row, search) => (row.dbName ?? row.name).toLowerCase().includes(search.toLowerCase())}
            isLoading={isLoading}
            searchPlaceholder={t("Search databases…")}
            empty={t("No databases found yet — run a sync.")}
          />
        </TabsContent>
        <TabsContent value="logins">
          <DataTable
            columns={loginColumns}
            rows={users}
            rowKey={(user) => user.id}
            query={loginQuery}
            filter={(user, search) => login(user).toLowerCase().includes(search.toLowerCase())}
            isLoading={isLoading}
            searchPlaceholder={t("Search logins…")}
            empty={t("No logins found. MySQL needs SELECT on the mysql schema to list them.")}
          />
        </TabsContent>
      </Tabs>
    </PageLayout>
  );
}
