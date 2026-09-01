import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
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
import { PageLayout } from "@/components/PageLayout";
import {
  CreatedInvite,
  Organization,
  addMember,
  isInviteResult,
  createOrganization,
  getOrganizationsPage,
} from "@/lib/organizations";
import { Label } from "@/components/ui/label";

export default function Organizations() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [orgName, setOrgName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [open, setOpen] = useState(false);
  const query = useTableQuery();

  const { data, isFetching } = useQuery({
    queryKey: ["organizations", "page", query.params],
    queryFn: () => getOrganizationsPage(query.params),
  });

  const orgMutation = useMutation({
    mutationFn: async () => {
      const org = await createOrganization({ name: orgName });
      const email = adminEmail.trim();
      if (!email) return { org, invite: null };

      // existing account joins straight away; anyone else gets an invite link back
      const result = await addMember(org.id, { email, role: "ADMIN" });
      return { org, invite: isInviteResult(result) ? result.invite : null };
    },
    onSuccess: ({ invite: created }) => {
      setOrgName("");
      setAdminEmail("");
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      setOpen(false);
      toast({
        title: "Organization created",
        description: created
          ? created.emailed
            ? `Invite emailed to ${created.email}.`
            : "Invite created, but the email failed — check the SMTP settings."
          : adminEmail
            ? "Admin added."
            : undefined,
      });
    },
    onError: (error: Error) =>
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      }),
  });

  const columns: Column<Organization>[] = [
    {
      header: "Name",
      className: "w-[28%]",
      cell: (o) => <span className="block truncate font-medium">{o.name}</span>,
    },
    {
      header: "Slug",
      className: "w-[26%]",
      cell: (o) => (
        <span className="block truncate text-muted-foreground">{o.slug}</span>
      ),
    },
    { header: "Members", className: "w-24", cell: (o) => o._count.members },
    { header: "Domains", className: "w-24", cell: (o) => o._count.domains },
    { header: "Apps", className: "w-20", cell: (o) => o._count.applications },
    {
      header: "",
      className: "w-32 text-right",
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
    <PageLayout
      icon={Building2}
      title="Organizations"
      description="Client tenants. Domain ownership lives on the Administration page."
      actions={
        <Dialog
          open={open}
          onOpenChange={setOpen}
        >
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
                  Creates a client tenant. Assign domains to it from the
                  Administration page.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="org-name">Name</Label>
                  <Input
                    id="org-name"
                    autoFocus
                    placeholder="Client name"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="org-admin">Admin email (optional)</Label>
                  <Input
                    id="org-admin"
                    type="email"
                    placeholder="admin@client.com"
                    value={adminEmail}
                    onChange={(e) => setAdminEmail(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Joins as ADMIN if the account exists, otherwise gets an
                    invite emailed to them. You can also invite members later
                    from the organization page.
                  </p>
                </div>

              </div>
              <DialogFooter>
                <Button
                  type="submit"
                  disabled={!orgName.trim() || orgMutation.isPending}
                >
                  {orgMutation.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Create
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      }
    >
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
    </PageLayout>
  );
}
