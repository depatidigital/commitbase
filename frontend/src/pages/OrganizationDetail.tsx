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
import { ArrowLeft, Loader2, Mail, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { getCurrentUser, isSuperAdmin } from "@/lib/auth";
import { ORG_ROLE_LABEL, OrgRole } from "@/lib/admin";
import { locale, t } from "@/lib/i18n";
import {
  createInvite,
  isMemberAdded,
  getInvites,
  getMembers,
  getOrganization,
  removeMember,
  revokeInvite,
  updateMemberRole,
} from "@/lib/organizations";
import { getServers, setOrganizationServer } from "@/lib/servers";

const ROLES: OrgRole[] = ["OWNER", "ADMIN", "MEMBER"];

export default function OrganizationDetail() {
  const { id = "" } = useParams();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const currentUser = getCurrentUser();
  const superadmin = isSuperAdmin();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [form, setForm] = useState({ email: "", role: "MEMBER" as OrgRole });
  const [pendingRemove, setPendingRemove] = useState<{
    userId: string;
    label: string;
  } | null>(null);
  const memberQuery = useTableQuery();
  const inviteQuery = useTableQuery();

  const onError = (error: Error) =>
    toast({
      title: t("Error"),
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

  // Only superadmins place orgs, so only they need the node list.
  const { data: servers = [] } = useQuery({
    queryKey: ["servers"],
    queryFn: getServers,
    enabled: superadmin,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["organizations", id] });
  };

  const [placement, setPlacement] = useState("");

  const placeMutation = useMutation({
    mutationFn: (serverId: string) => setOrganizationServer(id, serverId),
    onSuccess: (updated) => {
      refresh();
      toast({ title: t("Placed on {server}", { server: updated.server?.name ?? t("server") }) });
    },
    onError: (error: Error) => {
      setPlacement("");
      toast({ title: t("Error"), description: error.message, variant: "destructive" });
    },
  });

  const inviteMutation = useMutation({
    mutationFn: () => createInvite(id, form),
    onSuccess: (result) => {
      setForm({ email: "", role: "MEMBER" });
      refresh();

      // the email already had an account — the backend joined them, no link to copy
      if (isMemberAdded(result)) {
        setInviteOpen(false);
        toast({ title: t("Member added"), description: t("That account already existed.") });
        return;
      }

      // mail delivered? nothing for the admin to copy
      if (result.emailed) {
        setInviteOpen(false);
        toast({
          title: t("Invite sent"),
          description: t("An email is on its way to {email}.", { email: result.email }),
        });
        return;
      }

      // the invite row exists either way, but without mail nobody can act on it
      setInviteOpen(false);
      toast({
        title: t("Invite created, but the email failed"),
        description: t("Check the SMTP settings, then revoke and re-send the invite."),
        variant: "destructive",
      });
    },
    onError,
  });

  const roleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: OrgRole }) =>
      updateMemberRole(id, userId, role),
    onSuccess: () => {
      refresh();
      toast({ title: t("Member updated") });
    },
    onError,
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => removeMember(id, userId),
    onSuccess: () => {
      refresh();
      setPendingRemove(null);
      toast({ title: t("Member removed") });
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
      toast({ title: t("Invite revoked") });
    },
    onError,
  });

  const memberColumns: Column<(typeof members)[number]>[] = [
    {
      header: t("User"),
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
      header: t("Role"),
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
                {ORG_ROLE_LABEL[r]}
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
            aria-label={t("Remove {email}", { email: m.user.email })}
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
      header: t("Email"),
      className: "w-[45%]",
      cell: (i) => <span className="block truncate">{i.email}</span>,
    },
    {
      header: t("Role"),
      cell: (i) => <Badge variant="secondary">{ORG_ROLE_LABEL[i.role]}</Badge>,
    },
    {
      header: t("Status"),
      className: "w-48",
      cell: (i) =>
        i.acceptedAt ? (
          <Badge>{t("Accepted")}</Badge>
        ) : new Date(i.expiresAt) < new Date() ? (
          <Badge variant="destructive">{t("Expired")}</Badge>
        ) : (
          <Badge variant="outline">
            {t("Expires {date}", { date: new Date(i.expiresAt).toLocaleDateString(locale) })}
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
            aria-label={t("Revoke invite for {email}", { email: i.email })}
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
          {t("Organization not found.")}
        </CardContent>
      </Card>
    );
  }

  return (
    <PageLayout
      backTo="/organizations"
      title={org.name}
      description={`${org.slug} · ${t("{members} members · {domains} domains · {apps} apps", {
        members: org._count.members,
        domains: org._count.domains,
        apps: org._count.applications,
      })}`}
    >
      {superadmin && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("Server placement")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {org.server ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{org.server.name}</span>
                <Badge variant={org.server.status === "ONLINE" ? "default" : "destructive"}>
                  {org.server.status}
                </Badge>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Select
                  value={placement}
                  onValueChange={(v) => {
                    setPlacement(v);
                    placeMutation.mutate(v);
                  }}
                  disabled={placeMutation.isPending}
                >
                  <SelectTrigger className="w-64">
                    <SelectValue placeholder={t("Choose a server…")} />
                  </SelectTrigger>
                  <SelectContent>
                    {servers.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name} ({s.status})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {placeMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {org.server
                ? t("Placement is fixed once set: this tenant's OS user, home and apps live on that node. Moving the row would not move the files.")
                : t("Provisioning and deploys refuse to run until this organization is placed on a node.")}
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">
            {t("Members ({count})", { count: members.length })}
          </CardTitle>
          <Dialog
            open={inviteOpen}
            onOpenChange={setInviteOpen}
          >
            <DialogTrigger asChild>
              <Button>
                <Mail className="mr-2 h-4 w-4" /> {t("Invite")}
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
                  <DialogTitle>{t("Invite to {name}", { name: org.name })}</DialogTitle>
                  <DialogDescription>
                    {t("An existing account joins {name} straight away. Anyone else is emailed an invite link.", { name: org.name })}
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="invite-email">{t("Email")}</Label>
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
                    <Label>{t("Role")}</Label>
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
                            {ORG_ROLE_LABEL[r]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                </div>
                <DialogFooter>
                  <Button
                    type="submit"
                    disabled={!form.email || inviteMutation.isPending}
                  >
                    {inviteMutation.isPending && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    {t("Send invite")}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
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
            searchPlaceholder={t("Search members…")}
            empty={t("No members yet.")}
          />
        </CardContent>
      </Card>

      {invites.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("Pending invites")}</CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              columns={inviteColumns}
              rows={invites}
              rowKey={(i) => i.id}
              query={inviteQuery}
              filter={(i, q) => i.email.toLowerCase().includes(q.toLowerCase())}
              searchPlaceholder={t("Search invites…")}
              empty={t("No invites.")}
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
            <AlertDialogTitle>{t("Remove this member?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("{member} will lose access to {name}, including its domains and applications. They can be added back later.", {
                member: pendingRemove?.label ?? "",
                name: org.name,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                pendingRemove && removeMutation.mutate(pendingRemove.userId)
              }
            >
              {t("Remove member")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageLayout>
  );
}
