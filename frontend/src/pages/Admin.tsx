import { useState } from "react";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, ShieldCheck, TerminalSquare } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
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

const UNASSIGNED = "__none__";

export default function Admin() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = useTableQuery();
  const orgQuery = useTableQuery();
  const logQuery = useTableQuery(20);

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
      title: "Error",
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

  const { data: orgData, isFetching: orgsFetching } = useQuery({
    queryKey: ["admin", "organizations", orgQuery.params],
    queryFn: () => getAdminOrganizations(orgQuery.params),
  });

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
        title: "Domain ownership updated",
        description: "Its applications moved with it.",
      });
    },
    onError: (error: Error) => {
      setPendingAssign(null);
      onError(error);
    },
  });

  const provisionMutation = useMutation({
    mutationFn: (organizationId: string) => provisionOrganization(organizationId),
    onSuccess: (_result, organizationId) => {
      queryClient.invalidateQueries({ queryKey: ["admin", "organizations"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "provision-logs"] });
      const org = orgData?.data.find((o) => o.id === organizationId);
      setPendingProvision(null);
      toast({
        title: "Provisioned",
        description: org
          ? `cb-${org.slug} now has its own OS user, home and cgroup slice.`
          : "OS user provisioned.",
      });
    },
    onError: (error: Error) => {
      setPendingProvision(null);
      onError(error);
    },
  });

  // Any row tells us whether the server has isolation switched on at all.
  const isolationEnabled = orgData?.data[0]?.provisioning?.enabled ?? true;

  const columns: Column<AdminDomain>[] = [
    {
      header: "Domain",
      className: "w-[40%]",
      cell: (d) => <span className="block truncate font-medium">{d.name}</span>,
    },
    { header: "Apps", className: "w-20", cell: (d) => d._count.applications },
    {
      header: "Owning organization",
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
                "no organization",
            })
          }
        >
          <SelectTrigger className="w-full max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
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
      header: "Organization",
      className: "w-[30%]",
      cell: (o) => (
        <div className="min-w-0">
          <span className="block truncate font-medium">{o.name}</span>
          <span className="block truncate font-mono text-xs text-muted-foreground">
            {o.provisioning?.osUser ?? `cb-${o.slug}`}
          </span>
        </div>
      ),
    },
    {
      header: "Isolation",
      className: "w-40",
      cell: (o) => {
        const p = o.provisioning;
        if (!p) return <Badge variant="outline">Unknown</Badge>;
        if (!p.enabled) return <Badge variant="outline">Disabled</Badge>;
        if (!p.provisioned) return <Badge variant="destructive">Not provisioned</Badge>;
        if (!p.sliceInstalled) return <Badge variant="secondary">No resource limits</Badge>;
        return <Badge>Provisioned</Badge>;
      },
    },
    {
      header: "Home",
      className: "w-[25%]",
      cell: (o) => (
        <span className="block truncate font-mono text-xs text-muted-foreground">
          {o.provisioning?.home ?? "—"}
        </span>
      ),
    },
    {
      header: "Apps",
      className: "w-20",
      cell: (o) => o._count.applications,
    },
    {
      header: "",
      className: "w-32 text-right",
      cell: (o) => (
        <Button
          size="sm"
          variant={o.provisioning?.provisioned ? "outline" : "default"}
          disabled={!isolationEnabled || provisionMutation.isPending}
          onClick={() => setPendingProvision(o)}
        >
          {provisionMutation.isPending &&
          provisionMutation.variables === o.id ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : o.provisioning?.provisioned ? (
            "Re-provision"
          ) : (
            "Provision"
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
      header: "When",
      className: "w-44",
      cell: (l) => (
        <span className="text-xs text-muted-foreground">
          {new Date(l.timestamp).toLocaleString()}
        </span>
      ),
    },
    {
      header: "Level",
      className: "w-24",
      cell: (l) => <Badge variant={levelVariant(l.level)}>{l.level}</Badge>,
    },
    {
      header: "Message",
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
      header: "Trigger",
      className: "w-28",
      cell: (l) => (
        <span className="text-xs text-muted-foreground">
          {String(l.metadata?.trigger ?? "—")}
        </span>
      ),
    },
    {
      header: "By",
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
      title="Platform administration"
      description="Domain ownership and per-organization OS isolation."
    >
      <Tabs defaultValue="domains" className="space-y-4">
        <TabsList>
          <TabsTrigger value="domains">Domains</TabsTrigger>
          <TabsTrigger value="organizations">Organizations</TabsTrigger>
          <TabsTrigger value="logs">Provisioning log</TabsTrigger>
        </TabsList>

        <TabsContent value="domains">
          <DataTable
            columns={columns}
            rows={data?.data ?? []}
            rowKey={(d) => d.id}
            query={query}
            pagination={data?.pagination}
            isLoading={isFetching}
            searchPlaceholder="Search domain…"
            empty="No domains yet."
          />
        </TabsContent>

        <TabsContent value="organizations" className="space-y-4">
          {!isolationEnabled && (
            <Alert>
              <TerminalSquare className="h-4 w-4" />
              <AlertDescription>
                OS isolation is switched off on this server. Set{" "}
                <code className="font-mono">ORG_OS_ISOLATION=true</code> in the
                backend environment and restart it before provisioning.
              </AlertDescription>
            </Alert>
          )}

          <DataTable
            columns={orgColumns}
            rows={orgData?.data ?? []}
            rowKey={(o) => o.id}
            query={orgQuery}
            pagination={orgData?.pagination}
            isLoading={orgsFetching}
            searchPlaceholder="Search organization…"
            empty="No organizations yet."
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
            empty="Nothing provisioned yet."
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
              Move this domain to another organization?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAssign && (
                <>
                  <strong>{pendingAssign.domainName}</strong> and its{" "}
                  {pendingAssign.appCount} application
                  {pendingAssign.appCount === 1 ? "" : "s"} will move to{" "}
                  <strong>{pendingAssign.organizationName}</strong>. The
                  previous organization loses access immediately.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                pendingAssign &&
                assignMutation.mutate({
                  domainId: pendingAssign.domainId,
                  organizationId: pendingAssign.organizationId,
                })
              }
            >
              Move domain
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
              {pendingProvision?.provisioning?.provisioned
                ? "Re-run provisioning?"
                : "Provision this organization?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingProvision && (
                <>
                  Creates the OS user{" "}
                  <strong>cb-{pendingProvision.slug}</strong>, its home, disk
                  quota, cgroup slice and PHP-FPM pool. Re-running also repairs
                  file ownership and re-applies the resource limits — it does
                  not restart running applications.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                pendingProvision && provisionMutation.mutate(pendingProvision.id)
              }
            >
              Provision
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageLayout>
  );
}
