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
import { ShieldCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import {
  AdminDomain,
  assignDomain,
  getAdminDomains,
  unassignDomain,
} from "@/lib/admin";
import { getOrganizations } from "@/lib/organizations";

const UNASSIGNED = "__none__";

export default function Admin() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const query = useTableQuery();

  // moving a domain moves every application under it between tenants — confirm first
  const [pendingAssign, setPendingAssign] = useState<{
    domainId: string;
    domainName: string;
    appCount: number;
    organizationId: string;
    organizationName: string;
  } | null>(null);

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

  const columns: Column<AdminDomain>[] = [
    {
      header: "Domain",
      cell: (d) => <span className="font-medium">{d.name}</span>,
    },
    { header: "Apps", cell: (d) => d._count.applications },
    {
      header: "Owning organization",
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
          <SelectTrigger className="w-64">
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

  return (
    <PageLayout
      icon={ShieldCheck}
      title="Platform administration"
      description="Which organization owns which domain."
    >
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
    </PageLayout>
  );
}
