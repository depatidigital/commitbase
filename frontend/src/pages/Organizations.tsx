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
import { Building2, Copy, Loader2, Plus, Settings2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import {
  CreatedInvite,
  Organization,
  addMember,
  createInvite,
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
  const [invite, setInvite] = useState<CreatedInvite | null>(null);
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

      // existing account joins straight away; anyone else gets an invite link
      try {
        await addMember(org.id, { email, role: "ADMIN" });
        return { org, invite: null };
      } catch {
        return {
          org,
          invite: await createInvite(org.id, { email, role: "ADMIN" }),
        };
      }
    },
    onSuccess: ({ invite: created }) => {
      setOrgName("");
      setAdminEmail("");
      setInvite(created);
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      if (!created) setOpen(false);
      toast({
        title: "Organization created",
        description: created
          ? "Invite created for the admin — copy the link below."
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

  const inviteLink = (i: CreatedInvite) =>
    i.acceptUrl ?? `${window.location.origin}/accept-invite?token=${i.token}`;

  const columns: Column<Organization>[] = [
    {
      header: "Name",
      cell: (o) => <span className="font-medium">{o.name}</span>,
    },
    {
      header: "Slug",
      cell: (o) => <span className="text-muted-foreground">{o.slug}</span>,
    },
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
    <PageLayout
      icon={Building2}
      title="Organizations"
      description="Client tenants. Domain ownership lives on the Administration page."
      actions={
        <Dialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setInvite(null);
          }}
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
                    invite link. You can also add members later from the
                    organization page.
                  </p>
                </div>

                {invite && (
                  <div className="rounded-md border bg-muted/50 p-3 text-sm">
                    <p className="mb-2 font-medium">
                      Invite link for {invite.email} — shown once, copy it now:
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 truncate rounded bg-background px-2 py-1 text-xs">
                        {inviteLink(invite)}
                      </code>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          navigator.clipboard.writeText(inviteLink(invite));
                          toast({ title: "Copied to clipboard" });
                        }}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
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
