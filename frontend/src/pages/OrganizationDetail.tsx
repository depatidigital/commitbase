import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import { ArrowLeft, Copy, Loader2, Mail, Trash2, UserPlus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { getCurrentUser } from "@/lib/auth";
import { OrgRole } from "@/lib/admin";
import {
  CreatedInvite,
  addMember,
  isInviteResult,
  createInvite,
  getInvites,
  getMembers,
  getOrganization,
  removeMember,
  revokeInvite,
  updateMemberRole,
} from "@/lib/organizations";

const ROLES: OrgRole[] = ["OWNER", "ADMIN", "MEMBER"];

export default function OrganizationDetail() {
  const { id = "" } = useParams();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const currentUser = getCurrentUser();

  const [addOpen, setAddOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [form, setForm] = useState({ email: "", role: "MEMBER" as OrgRole });
  const [lastInvite, setLastInvite] = useState<CreatedInvite | null>(null);
  const [pendingRemove, setPendingRemove] = useState<{
    userId: string;
    label: string;
  } | null>(null);
  const memberQuery = useTableQuery();
  const inviteQuery = useTableQuery();

  const onError = (error: Error) =>
    toast({
      title: "Error",
      description: error.message,
      variant: "destructive",
    });

  const { data: org, isLoading } = useQuery({
    queryKey: ["organizations", id],
    queryFn: () => getOrganization(id),
    enabled: !!id,
  });

  const { data: members = [] } = useQuery({
    queryKey: ["organizations", id, "members"],
    queryFn: () => getMembers(id),
    enabled: !!id,
  });

  const { data: invites = [] } = useQuery({
    queryKey: ["organizations", id, "invites"],
    queryFn: () => getInvites(id),
    enabled: !!id,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["organizations", id] });
  };

  const addMutation = useMutation({
    mutationFn: () => addMember(id, form),
    onSuccess: (result) => {
      setForm({ email: "", role: "MEMBER" });
      refresh();
      if (isInviteResult(result)) {
        setLastInvite(result.invite);
        toast({
          title: "Invite created",
          description: "No account with that email yet — copy the link, it is shown only once.",
        });
        return;
      }
      setAddOpen(false);
      toast({ title: "Member added" });
    },
    onError,
  });

  const inviteMutation = useMutation({
    mutationFn: () => createInvite(id, form),
    onSuccess: (invite) => {
      setLastInvite(invite);
      setForm({ email: "", role: "MEMBER" });
      refresh();
      toast({
        title: "Invite created",
        description: "Copy the link — it is shown only once.",
      });
    },
    onError,
  });

  const roleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: OrgRole }) =>
      updateMemberRole(id, userId, role),
    onSuccess: () => {
      refresh();
      toast({ title: "Member updated" });
    },
    onError,
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => removeMember(id, userId),
    onSuccess: () => {
      refresh();
      setPendingRemove(null);
      toast({ title: "Member removed" });
    },
    onError: (error: Error) => {
      setPendingRemove(null);
      onError(error);
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => revokeInvite(id, inviteId),
    onSuccess: () => {
      refresh();
      toast({ title: "Invite revoked" });
    },
    onError,
  });

  const inviteLink = (invite: CreatedInvite) =>
    invite.acceptUrl ??
    `${window.location.origin}/accept-invite?token=${invite.token}`;

  const memberColumns: Column<(typeof members)[number]>[] = [
    {
      header: "User",
      className: "w-[45%]",
      cell: (m) => (
        <>
          <div className="truncate font-medium">
            {m.user.name || m.user.email}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {m.user.email}
          </div>
        </>
      ),
    },
    {
      header: "Role",
      className: "w-44",
      cell: (m) => (
        <Select
          value={m.role}
          onValueChange={(v) =>
            roleMutation.mutate({ userId: m.user.id, role: v as OrgRole })
          }
        >
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
    },
    {
      header: "",
      className: "w-20",
      cell: (m) =>
        m.user.id !== currentUser?.id ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove ${m.user.email}`}
            onClick={() =>
              setPendingRemove({
                userId: m.user.id,
                label: m.user.name || m.user.email,
              })
            }
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        ) : null,
    },
  ];

  const inviteColumns: Column<(typeof invites)[number]>[] = [
    {
      header: "Email",
      className: "w-[45%]",
      cell: (i) => <span className="block truncate">{i.email}</span>,
    },
    {
      header: "Role",
      cell: (i) => <Badge variant="secondary">{i.role}</Badge>,
    },
    {
      header: "Status",
      className: "w-48",
      cell: (i) =>
        i.acceptedAt ? (
          <Badge>Accepted</Badge>
        ) : new Date(i.expiresAt) < new Date() ? (
          <Badge variant="destructive">Expired</Badge>
        ) : (
          <Badge variant="outline">
            Expires {new Date(i.expiresAt).toLocaleDateString()}
          </Badge>
        ),
    },
    {
      header: "",
      className: "w-20",
      cell: (i) =>
        !i.acceptedAt ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Revoke invite for ${i.email}`}
            onClick={() => revokeMutation.mutate(i.id)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        ) : null,
    },
  ];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (!org) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-muted-foreground">
          Organization not found.
        </CardContent>
      </Card>
    );
  }

  return (
    <PageLayout
      backTo="/organizations"
      title={org.name}
      description={`${org.slug} · ${org._count.members} members · ${org._count.domains} domains · ${org._count.applications} apps`}
      actions={
        <>
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button>
                <UserPlus className="mr-2 h-4 w-4" /> Add member
              </Button>
            </DialogTrigger>
            <DialogContent>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  addMutation.mutate();
                }}
              >
                <DialogHeader>
                  <DialogTitle>Add member by email</DialogTitle>
                  <DialogDescription>
                    Adds an existing account to {org.name} straight away. If no
                    account uses that email, send an invite link instead.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="member-email">Email</Label>
                    <Input
                      id="member-email"
                      autoFocus
                      type="email"
                      value={form.email}
                      onChange={(e) =>
                        setForm({ ...form, email: e.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Role</Label>
                    <Select
                      value={form.role}
                      onValueChange={(v) =>
                        setForm({ ...form, role: v as OrgRole })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLES.map((r) => (
                          <SelectItem key={r} value={r}>
                            {r}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    type="submit"
                    disabled={!form.email || addMutation.isPending}
                  >
                    {addMutation.isPending && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    Add member
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>

          <Dialog
            open={inviteOpen}
            onOpenChange={(open) => {
              setInviteOpen(open);
              if (!open) setLastInvite(null);
            }}
          >
            <DialogTrigger asChild>
              <Button variant="outline">
                <Mail className="mr-2 h-4 w-4" /> Invite
              </Button>
            </DialogTrigger>
            <DialogContent>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  inviteMutation.mutate();
                }}
              >
                <DialogHeader>
                  <DialogTitle>Invite to {org.name}</DialogTitle>
                  <DialogDescription>
                    For people without an account yet. The link is stored hashed
                    and shown once — copy it before closing.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="invite-email">Email</Label>
                    <Input
                      id="invite-email"
                      type="email"
                      value={form.email}
                      onChange={(e) =>
                        setForm({ ...form, email: e.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Role</Label>
                    <Select
                      value={form.role}
                      onValueChange={(v) =>
                        setForm({ ...form, role: v as OrgRole })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLES.map((r) => (
                          <SelectItem key={r} value={r}>
                            {r}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {lastInvite && (
                    <div className="rounded-md border bg-muted/50 p-3 text-sm">
                      <p className="mb-2 font-medium">
                        Invite link for {lastInvite.email} — copy it now:
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 truncate rounded bg-background px-2 py-1 text-xs">
                          {inviteLink(lastInvite)}
                        </code>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            navigator.clipboard.writeText(
                              inviteLink(lastInvite),
                            );
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
                    disabled={!form.email || inviteMutation.isPending}
                  >
                    {inviteMutation.isPending && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    Create invite
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </>
      }
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Members ({members.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={memberColumns}
            rows={members}
            rowKey={(m) => m.id}
            query={memberQuery}
            filter={(m, q) =>
              `${m.user.name ?? ""} ${m.user.email}`
                .toLowerCase()
                .includes(q.toLowerCase())
            }
            searchPlaceholder="Search members…"
            empty="No members yet."
          />
        </CardContent>
      </Card>

      {invites.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pending invites</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={inviteColumns}
              rows={invites}
              rowKey={(i) => i.id}
              query={inviteQuery}
              filter={(i, q) => i.email.toLowerCase().includes(q.toLowerCase())}
              searchPlaceholder="Search invites…"
              empty="No invites."
            />
          </CardContent>
        </Card>
      )}

      <AlertDialog
        open={!!pendingRemove}
        onOpenChange={(open) => !open && setPendingRemove(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this member?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRemove?.label} will lose access to {org.name}, including
              its domains and applications. They can be added back later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                pendingRemove && removeMutation.mutate(pendingRemove.userId)
              }
            >
              Remove member
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageLayout>
  );
}
