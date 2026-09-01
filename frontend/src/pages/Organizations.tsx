import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Building2, Loader2, Plus, Settings2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { Organization, createOrganization, getOrganizationsPage } from "@/lib/organizations";

export default function Organizations() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [orgName, setOrgName] = useState("");
  const [open, setOpen] = useState(false);
  const query = useTableQuery();

  const { data, isFetching } = useQuery({
    queryKey: ["organizations", "page", query.params],
    queryFn: () => getOrganizationsPage(query.params),
  });

  const orgMutation = useMutation({
    mutationFn: () => createOrganization({ name: orgName }),
    onSuccess: () => {
      setOrgName("");
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      toast({ title: "Organization created" });
    },
    onError: (error: Error) =>
      toast({ title: "Error", description: error.message, variant: "destructive" }),
  });

  const columns: Column<Organization>[] = [
    { header: "Name", cell: (o) => <span className="font-medium">{o.name}</span> },
    { header: "Slug", cell: (o) => <span className="text-muted-foreground">{o.slug}</span> },
    { header: "Members", cell: (o) => o._count.members },
    { header: "Domains", cell: (o) => o._count.domains },
    { header: "Apps", cell: (o) => o._count.applications },
    {
      header: "",
      className: "w-28 text-right",
      cell: (o) => (
        <Button asChild size="sm" variant="outline">
          <Link to={`/organizations/${o.id}`}>
            <Settings2 className="mr-2 h-4 w-4" /> Manage
          </Link>
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Building2 className="h-5 w-5" /> Organizations
          </h1>
          <p className="text-sm text-muted-foreground">
            Client tenants. Domain ownership lives on the Administration page.
          </p>
        </div>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" /> New organization
            </Button>
          </DialogTrigger>
          <DialogContent>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                orgMutation.mutate();
              }}
            >
              <DialogHeader>
                <DialogTitle>New organization</DialogTitle>
                <DialogDescription>
                  Creates a client tenant. Assign domains to it from the Administration page.
                </DialogDescription>
              </DialogHeader>
              <div className="py-4">
                <Input
                  autoFocus
                  placeholder="Client name"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                />
              </div>
              <DialogFooter>
                <Button type="submit" disabled={!orgName.trim() || orgMutation.isPending}>
                  {orgMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Create
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All organizations</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            rows={data?.data ?? []}
            rowKey={(o) => o.id}
            query={query}
            pagination={data?.pagination}
            isLoading={isFetching}
            searchPlaceholder="Search name or slug…"
            empty="No organizations yet."
          />
        </CardContent>
      </Card>
    </div>
  );
}
