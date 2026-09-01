import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import { Copy, Loader2, Mail, Trash2, Users } from "lucide-react";
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
import { getCurrentUser } from "@/lib/auth";
import { OrgRole } from "@/lib/admin";
import {
  createInvite,
  getInvites,
  getMembers,
  getOrganizations,
  removeMember,
  revokeInvite,
  updateMemberRole,
  CreatedInvite,
} from "@/lib/organizations";

const ROLES: OrgRole[] = ["OWNER", "ADMIN", "MEMBER"];

export default function Team() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const currentUser = getCurrentUser();

  const [orgId, setOrgId] = useState<string>("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrgRole>("MEMBER");
  const [lastInvite, setLastInvite] = useState<CreatedInvite | null>(null);
  const [pendingRemove, setPendingRemove] = useState<{
    userId: string;
    label: string;
  } | null>(null);

  const { data: organizations = [], isLoading: orgsLoading } = useQuery({
    queryKey: ["organizations"],
    queryFn: getOrganizations,
  });

  useEffect(() => {
    if (!orgId && organizations.length) setOrgId(organizations[0].id);
  }, [organizations, orgId]);

  const org = organizations.find((o) => o.id === orgId);
  // platform admins can manage any org even without a membership row
  const canManage =
    currentUser?.role === "ADMIN" || org?.myRole === "OWNER" || org?.myRole === "ADMIN";

  const { data: members = [] } = useQuery({
    queryKey: ["organizations", orgId, "members"],
    queryFn: () => getMembers(orgId),
    enabled: !!orgId,
  });

  const { data: invites = [] } = useQuery({
    queryKey: ["organizations", orgId, "invites"],
    queryFn: () => getInvites(orgId),
    enabled: !!orgId && canManage,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["organizations", orgId, "members"] });
    queryClient.invalidateQueries({ queryKey: ["organizations", orgId, "invites"] });
  };

  const onError = (error: Error) =>
    toast({ title: "Error", description: error.message, variant: "destructive" });

  const inviteMutation = useMutation({
    mutationFn: () => createInvite(orgId, { email: inviteEmail, role: inviteRole }),
    onSuccess: (invite) => {
      setLastInvite(invite);
      setInviteEmail("");
      refresh();
      toast({ title: "Invite created", description: "Copy the link below — it is shown only once." });
    },
    onError,
  });

  const roleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: OrgRole }) =>
      updateMemberRole(orgId, userId, role),
    onSuccess: () => {
      refresh();
      toast({ title: "Member updated" });
    },
    onError,
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => removeMember(orgId, userId),
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
    mutationFn: (inviteId: string) => revokeInvite(orgId, inviteId),
    onSuccess: () => {
      refresh();
      toast({ title: "Invite revoked" });
    },
    onError,
  });

  const copy = (value: string) => {
    navigator.clipboard.writeText(value);
    toast({ title: "Copied to clipboard" });
  };

  if (orgsLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (!organizations.length) {
    return (
      <div>
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            You are not a member of any organization yet.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Users className="h-5 w-5" /> Team
          </h1>
          <p className="text-sm text-muted-foreground">
            People who can manage this organization's domains and applications.
          </p>
        </div>

        <Select value={orgId} onValueChange={setOrgId}>
          <SelectTrigger className="w-64">
            <SelectValue placeholder="Select organization" />
          </SelectTrigger>
          <SelectContent>
            {organizations.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Mail className="h-4 w-4" /> Invite someone
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="email"
                placeholder="teammate@client.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
              <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as OrgRole)}>
                <SelectTrigger className="sm:w-40">
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
              <Button
                onClick={() => inviteMutation.mutate()}
                disabled={!inviteEmail || inviteMutation.isPending}
              >
                {inviteMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Send invite
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              The invite link is shown once, right after you create it. It is stored
              hashed, so it cannot be retrieved later — copy it before leaving this
              page.
            </p>

            {lastInvite && (
              <div className="rounded-md border bg-muted/50 p-3 text-sm">
                <p className="mb-2 font-medium">
                  Invite link for {lastInvite.email} — shown once, copy it now:
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded bg-background px-2 py-1 text-xs">
                    {lastInvite.acceptUrl ??
                      `${window.location.origin}/accept-invite?token=${lastInvite.token}`}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      copy(
                        lastInvite.acceptUrl ??
                          `${window.location.origin}/accept-invite?token=${lastInvite.token}`
                      )
                    }
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Members ({members.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <div className="font-medium">{m.user.name || m.user.email}</div>
                    <div className="text-xs text-muted-foreground">{m.user.email}</div>
                  </TableCell>
                  <TableCell>
                    {canManage ? (
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
                    ) : (
                      <Badge variant="secondary">{m.role}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {canManage && m.user.id !== currentUser?.id && (
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
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {canManage && invites.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pending invites</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {invites.map((i) => {
                  const expired = new Date(i.expiresAt) < new Date();
                  return (
                    <TableRow key={i.id}>
                      <TableCell>{i.email}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{i.role}</Badge>
                      </TableCell>
                      <TableCell>
                        {i.acceptedAt ? (
                          <Badge>Accepted</Badge>
                        ) : expired ? (
                          <Badge variant="destructive">Expired</Badge>
                        ) : (
                          <Badge variant="outline">
                            Expires {new Date(i.expiresAt).toLocaleDateString()}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {!i.acceptedAt && (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Revoke invite for ${i.email}`}
                            onClick={() => revokeMutation.mutate(i.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
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
              {pendingRemove?.label} will lose access to {org?.name ?? "this organization"}
              , including its domains and applications. They can be invited back later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => pendingRemove && removeMutation.mutate(pendingRemove.userId)}
            >
              Remove member
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
