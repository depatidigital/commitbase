import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Building2, Loader2, Plus, ShieldCheck } from "lucide-react";
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
import { assignDomain, getAdminDomains, unassignDomain } from "@/lib/admin";
import { createOrganization, getOrganizations } from "@/lib/organizations";

const UNASSIGNED = "__none__";

export default function Admin() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [orgName, setOrgName] = useState("");
  // moving a domain moves every application under it between tenants — confirm first
  const [pendingAssign, setPendingAssign] = useState<{
    domainId: string;
    domainName: string;
    appCount: number;
    organizationId: string;
    organizationName: string;
  } | null>(null);

  const onError = (error: Error) =>
    toast({ title: "Error", description: error.message, variant: "destructive" });

  const { data: organizations = [] } = useQuery({
    queryKey: ["organizations"],
    queryFn: getOrganizations,
  });
  const { data: domains = [], isLoading: domainsLoading } = useQuery({
    queryKey: ["admin", "domains"],
    queryFn: getAdminDomains,
  });

  const orgMutation = useMutation({
    mutationFn: () => createOrganization({ name: orgName }),
    onSuccess: () => {
      setOrgName("");
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      toast({ title: "Organization created" });
    },
    onError,
  });

  const assignMutation = useMutation({
    mutationFn: ({ domainId, organizationId }: { domainId: string; organizationId: string }) =>
      organizationId === UNASSIGNED
        ? unassignDomain(domainId)
        : assignDomain(domainId, organizationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "domains"] });
      queryClient.invalidateQueries({ queryKey: ["domains"] });
      setPendingAssign(null);
      toast({ title: "Domain ownership updated", description: "Its applications moved with it." });
    },
    onError: (error: Error) => {
      setPendingAssign(null);
      onError(error);
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" /> Platform administration
        </h1>
        <p className="text-sm text-muted-foreground">
          Organizations and which organization owns which domain.
        </p>
      </div>

      <Tabs defaultValue="domains">
        <TabsList>
          <TabsTrigger value="domains">Domains</TabsTrigger>
          <TabsTrigger value="organizations">Organizations</TabsTrigger>
        </TabsList>

        <TabsContent value="domains" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Domain ownership</CardTitle>
            </CardHeader>
            <CardContent>
              {domainsLoading ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Domain</TableHead>
                      <TableHead>Apps</TableHead>
                      <TableHead>Owning organization</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {domains.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell className="font-medium">{d.name}</TableCell>
                        <TableCell>{d._count.applications}</TableCell>
                        <TableCell>
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
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="organizations" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Plus className="h-4 w-4" /> New organization
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 sm:flex-row">
              <Input
                placeholder="Client name"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
              />
              <Button onClick={() => orgMutation.mutate()} disabled={!orgName || orgMutation.isPending}>
                {orgMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Building2 className="h-4 w-4" /> Organizations
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Slug</TableHead>
                    <TableHead>Members</TableHead>
                    <TableHead>Domains</TableHead>
                    <TableHead>Apps</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {organizations.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="font-medium">{o.name}</TableCell>
                      <TableCell className="text-muted-foreground">{o.slug}</TableCell>
                      <TableCell>{o._count.members}</TableCell>
                      <TableCell>{o._count.domains}</TableCell>
                      <TableCell>{o._count.applications}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

      </Tabs>

      <AlertDialog
        open={!!pendingAssign}
        onOpenChange={(open) => !open && setPendingAssign(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move this domain to another organization?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAssign && (
                <>
                  <strong>{pendingAssign.domainName}</strong> and its{" "}
                  {pendingAssign.appCount} application
                  {pendingAssign.appCount === 1 ? "" : "s"} will move to{" "}
                  <strong>{pendingAssign.organizationName}</strong>. The previous
                  organization loses access immediately.
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
    </div>
  );
}
