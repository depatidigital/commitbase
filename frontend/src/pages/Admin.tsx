import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, ShieldCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { OrgNodeBadges, OrgNodeLogDialog, anyNodePending } from "@/components/OrgNodes";
import {
  AdminDomain,
  AdminOrganization,
  ProvisionLog,
  assignDomain,
  getAdminDomains,
  getAdminOrganizations,
  getProvisionLogs,
  provisionOrganization,
  unassignDomain,
} from "@/lib/admin";
import { getOrganizations } from "@/lib/organizations";
import { isSuperAdmin } from "@/lib/auth";
import { locale, t } from "@/lib/i18n";

const UNASSIGNED = "__none__";

export default function Admin() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = useTableQuery();
  const orgQuery = useTableQuery();
  const logQuery = useTableQuery(20);
  const superadmin = isSuperAdmin();

  // moving a domain moves every application under it between tenants — confirm first
  const [pendingAssign, setPendingAssign] = useState<{
    domainId: string;
    domainName: string;
    appCount: number;
    organizationId: string;
    organizationName: string;
  } | null>(null);

  // re-running provisioning is idempotent but touches a live tenant — confirm too
  const [pendingProvision, setPendingProvision] =
    useState<AdminOrganization | null>(null);

  const onError = (error: Error) =>
    toast({
      title: t("Error"),
      description: error.message,
      variant: "destructive",
    });

  // full list — this feeds the owner picker, not a paged table
  const { data: organizations = [] } = useQuery({
    queryKey: ["organizations"],
    queryFn: getOrganizations,
  });

  const { data, isFetching } = useQuery({
    queryKey: ["admin", "domains", query.params],
    queryFn: () => getAdminDomains(query.params),
  });

  // the org node whose provisioning output is open
  const [logFor, setLogFor] = useState<{ orgId: string; nodeId: string } | null>(null);

  const { data: orgData, isFetching: orgsFetching } = useQuery({
    queryKey: ["admin", "organizations", orgQuery.params],
    queryFn: () => getAdminOrganizations(orgQuery.params),
    // every 2s while an output is open, every 5s while a node is provisioning
    refetchInterval: (q) => (logFor ? 2000 : anyNodePending(q.state.data?.data) ? 5000 : false),
  });
  const logOrg = orgData?.data.find((o) => o.id === logFor?.orgId) ?? null;
  const logNode = logOrg?.nodes.find((n) => n.id === logFor?.nodeId) ?? null;

  const { data: logData, isFetching: logsFetching } = useQuery({
    queryKey: ["admin", "provision-logs", logQuery.params],
    queryFn: () => getProvisionLogs(logQuery.params),
  });

  const assignMutation = useMutation({
    mutationFn: ({
      domainId,
      organizationId,
    }: {
      domainId: string;
      organizationId: string;
    }) =>
      organizationId === UNASSIGNED
        ? unassignDomain(domainId)
        : assignDomain(domainId, organizationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "domains"] });
      queryClient.invalidateQueries({ queryKey: ["domains"] });
      setPendingAssign(null);
      toast({
        title: t("Domain ownership updated"),
        description: t("Its applications moved with it."),
      });
    },
    onError: (error: Error) => {
      setPendingAssign(null);
      onError(error);
    },
  });

  const provisionMutation = useMutation({
    mutationFn: (organizationId: string) => provisionOrganization(organizationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "organizations"] });
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      setPendingProvision(null);
      // runs in the background; the Organizations list shows the outcome
      toast({ title: t("Provisioning queued") });
    },
    onError: (error: Error) => {
      setPendingProvision(null);
      onError(error);
    },
  });


  const columns: Column<AdminDomain>[] = [
    {
      header: t("Domain"),
      className: "w-[40%]",
      cell: (d) => <span className="block truncate font-medium">{d.name}</span>,
    },
    { header: t("Apps"), className: "w-20", cell: (d) => d._count.applications },
    {
      header: t("Owning organization"),
      className: "w-[40%]",
      cell: (d) => (
        <Select
          value={d.organization?.id ?? UNASSIGNED}
          onValueChange={(organizationId) =>
            setPendingAssign({
              domainId: d.id,
              domainName: d.name,
              appCount: d._count.applications,
              organizationId,
              organizationName:
                organizations.find((o) => o.id === organizationId)?.name ??
                t("no organization"),
            })
          }
        >
          <SelectTrigger className="w-full max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNASSIGNED}>{t("Unassigned")}</SelectItem>
            {organizations.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
    },
  ];

  const orgColumns: Column<AdminOrganization>[] = [
    {
      header: t("Organization"),
      className: "w-[26%]",
      cell: (o) => (
        <div className="min-w-0">
          <span className="block truncate font-medium">{o.name}</span>
          <span className="block truncate font-mono text-xs text-muted-foreground">cb-{o.slug}</span>
        </div>
      ),
    },
    {
      header: t("Default server"),
      className: "w-36",
      cell: (o) =>
        !o.defaultServer ? (
          <Link to={`/organizations/${o.id}`} className="text-xs text-muted-foreground hover:underline">
            {t("Not set")}
          </Link>
        ) : superadmin ? (
          <Link to={`/servers/${o.defaultServer.id}`} className="block truncate hover:underline">
            {o.defaultServer.name}
          </Link>
        ) : (
          <span className="block truncate">{o.defaultServer.name}</span>
        ),
    },
    {
      header: t("Provisioned on"),
      className: "w-[34%]",
      cell: (o) => <OrgNodeBadges nodes={o.nodes} onOpen={(node) => setLogFor({ orgId: o.id, nodeId: node.id })} />,
    },
    {
      header: t("Apps"),
      className: "w-20",
      cell: (o) => o._count.applications,
    },
    {
      header: "",
      className: "w-32 text-right",
      cell: (o) => (
        <Button
          size="sm"
          variant={o.nodes.length ? "outline" : "default"}
          // nothing to do until the org is on a server or has a default one
          disabled={provisionMutation.isPending || (!o.nodes.length && !o.defaultServer)}
          onClick={() => setPendingProvision(o)}
        >
          {provisionMutation.isPending && provisionMutation.variables === o.id ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : o.nodes.length ? (
            t("Re-provision")
          ) : (
            t("Provision")
          )}
        </Button>
      ),
    },
  ];

  const levelVariant = (level: ProvisionLog["level"]) =>
    level === "ERROR" || level === "FATAL"
      ? ("destructive" as const)
      : level === "WARN"
        ? ("secondary" as const)
        : ("outline" as const);

  const logColumns: Column<ProvisionLog>[] = [
    {
      header: t("When"),
      className: "w-44",
      cell: (l) => (
        <span className="text-xs text-muted-foreground">
          {new Date(l.timestamp).toLocaleString(locale)}
        </span>
      ),
    },
    {
      header: t("Level"),
      className: "w-24",
      cell: (l) => <Badge variant={levelVariant(l.level)}>{l.level}</Badge>,
    },
    {
      header: t("Message"),
      cell: (l) => (
        <div className="min-w-0">
          <span className="block truncate">{l.message}</span>
          {typeof l.metadata?.output === "string" && (
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs text-muted-foreground">
              {l.metadata.output}
            </pre>
          )}
        </div>
      ),
    },
    {
      header: t("Trigger"),
      className: "w-28",
      cell: (l) => (
        <span className="text-xs text-muted-foreground">
          {String(l.metadata?.trigger ?? "—")}
        </span>
      ),
    },
    {
      header: t("By"),
      className: "w-48",
      cell: (l) => (
        <span className="block truncate text-xs text-muted-foreground">
          {l.user?.email ?? "—"}
        </span>
      ),
    },
  ];

  return (
    <PageLayout
      icon={ShieldCheck}
      title={t("Platform administration")}
      description={t("Domain ownership and per-organization OS isolation.")}
    >
      <Tabs defaultValue="domains" className="space-y-4">
        <TabsList>
          <TabsTrigger value="domains">{t("Domains")}</TabsTrigger>
          <TabsTrigger value="organizations">{t("Organizations")}</TabsTrigger>
          <TabsTrigger value="logs">{t("Provisioning log")}</TabsTrigger>
        </TabsList>

        <TabsContent value="domains">
          <DataTable
            columns={columns}
            rows={data?.data ?? []}
            rowKey={(d) => d.id}
            query={query}
            pagination={data?.pagination}
            isLoading={isFetching}
            searchPlaceholder={t("Search domain…")}
            empty={t("No domains yet.")}
          />
        </TabsContent>

        <TabsContent value="organizations" className="space-y-4">
          <DataTable
            columns={orgColumns}
            rows={orgData?.data ?? []}
            rowKey={(o) => o.id}
            query={orgQuery}
            pagination={orgData?.pagination}
            isLoading={orgsFetching}
            searchPlaceholder={t("Search organization…")}
            empty={t("No organizations yet.")}
          />
        </TabsContent>

        <TabsContent value="logs">
          <DataTable
            columns={logColumns}
            rows={logData?.data ?? []}
            rowKey={(l) => l.id}
            query={logQuery}
            pagination={logData?.pagination}
            isLoading={logsFetching}
            empty={t("Nothing provisioned yet.")}
          />
        </TabsContent>
      </Tabs>

      <AlertDialog
        open={!!pendingAssign}
        onOpenChange={(open) => !open && setPendingAssign(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Move this domain to another organization?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAssign && (
                <>
                  {pendingAssign.appCount === 1
                    ? t("{domain} and its {count} application will move to {organization}.", {
                        domain: pendingAssign.domainName,
                        count: pendingAssign.appCount,
                        organization: pendingAssign.organizationName,
                      })
                    : t("{domain} and its {count} applications will move to {organization}.", {
                        domain: pendingAssign.domainName,
                        count: pendingAssign.appCount,
                        organization: pendingAssign.organizationName,
                      })}{" "}
                  {t("The previous organization loses access immediately.")}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                pendingAssign &&
                assignMutation.mutate({
                  domainId: pendingAssign.domainId,
                  organizationId: pendingAssign.organizationId,
                })
              }
            >
              {t("Move domain")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!pendingProvision}
        onOpenChange={(open) => !open && setPendingProvision(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingProvision?.nodes.length
                ? t("Re-run provisioning?")
                : t("Provision this organization?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingProvision && (
                <>
                  {t("Creates the OS user {user}, its home, disk quota, cgroup slice and PHP-FPM pool.", {
                    user: `cb-${pendingProvision.slug}`,
                  })}{" "}
                  {pendingProvision.nodes.length
                    ? t("Runs on every server it is on: {servers}.", {
                        servers: pendingProvision.nodes.map((n) => n.server.name).join(", "),
                      })
                    : t("Runs on its default server, {server}.", { server: pendingProvision.defaultServer?.name ?? "—" })}{" "}
                  {t("Re-running also repairs file ownership and re-applies the resource limits — it does not restart running applications.")}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                pendingProvision && provisionMutation.mutate(pendingProvision.id)
              }
            >
              {t("Provision")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <OrgNodeLogDialog orgName={logOrg?.name ?? ""} node={logNode} onClose={() => setLogFor(null)} />
    </PageLayout>
  );
}
