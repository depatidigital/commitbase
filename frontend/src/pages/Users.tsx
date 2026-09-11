import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Loader2, Plus, Users as UsersIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { createUser, getUsers, updateUser, AdminUser, ORG_ROLE_LABEL, PLATFORM_ROLE_LABEL } from "@/lib/admin";
import { t } from "@/lib/i18n";

const EMPTY_USER = { email: "", name: "", password: "" };

export default function Users() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [newUser, setNewUser] = useState(EMPTY_USER);

  const onError = (error: Error) =>
    toast({
      title: t("Error"),
      description: error.message,
      variant: "destructive",
    });

  const query = useTableQuery();

  const { data, isFetching } = useQuery({
    queryKey: ["admin", "users", query.params],
    queryFn: () => getUsers(query.params),
  });

  const userMutation = useMutation({
    mutationFn: () => createUser({ ...newUser, role: "CLIENT" }),
    onSuccess: () => {
      setNewUser(EMPTY_USER);
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      toast({
        title: t("User created"),
        description: t("Invite them to an organization from the Team page."),
      });
    },
    onError,
  });

  const toggleActive = useMutation({
    mutationFn: ({ user, isActive }: { user: AdminUser; isActive: boolean }) =>
      updateUser(user.id, { isActive }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      toast({ title: t("User updated") });
    },
    onError,
  });

  const columns: Column<AdminUser>[] = [
    {
      header: t("User"),
      className: "w-[30%]",
      cell: (u) => (
        <>
          <div className="truncate font-medium">{u.name || u.email}</div>
          <div className="truncate text-xs text-muted-foreground">
            {u.email}
          </div>
        </>
      ),
    },
    {
      header: t("Platform role"),
      className: "w-32",
      cell: (u) => (
        <Badge variant={u.role === "ADMIN" ? "default" : "secondary"}>
          {PLATFORM_ROLE_LABEL[u.role] ?? u.role}
        </Badge>
      ),
    },
    {
      header: t("Organizations"),
      className: "space-x-1",
      cell: (u) =>
        u.memberships.length === 0 ? (
          <span className="text-xs text-muted-foreground">{t("none")}</span>
        ) : (
          u.memberships.map((m) => (
            <Badge
              key={m.organization.id}
              variant="outline"
              className="max-w-full truncate"
            >
              {m.organization.name} · {ORG_ROLE_LABEL[m.role]}
            </Badge>
          ))
        ),
    },
    {
      header: t("Active"),
      className: "w-20",
      cell: (u) => (
        <Switch
          checked={u.isActive}
          onCheckedChange={(isActive) =>
            toggleActive.mutate({ user: u, isActive })
          }
        />
      ),
    },
  ];

  return (
    <PageLayout
      icon={UsersIcon}
      title={t("Users")}
      description={t("Client accounts on the platform and their organization memberships.")}
      actions={
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" /> {t("New user")}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("New client account")}</DialogTitle>
              <DialogDescription>
                {t("They sign in with this temporary password and must change it on first login.")}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">{t("Email")}</Label>
                <Input
                  id="email"
                  type="email"
                  value={newUser.email}
                  onChange={(e) =>
                    setNewUser({ ...newUser, email: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="name">{t("Name")}</Label>
                <Input
                  id="name"
                  value={newUser.name}
                  onChange={(e) =>
                    setNewUser({ ...newUser, name: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">{t("Temporary password")}</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder={t("min 8 characters")}
                  value={newUser.password}
                  onChange={(e) =>
                    setNewUser({ ...newUser, password: e.target.value })
                  }
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                {t("Cancel")}
              </Button>
              <Button
                onClick={() => userMutation.mutate()}
                disabled={
                  !newUser.email ||
                  newUser.password.length < 8 ||
                  userMutation.isPending
                }
              >
                {userMutation.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {t("Create")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      }
    >
      <DataTable
        columns={columns}
        rows={data?.data ?? []}
        rowKey={(u) => u.id}
        query={query}
        pagination={data?.pagination}
        isLoading={isFetching}
        searchPlaceholder={t("Search email or name…")}
        empty={t("No users found.")}
      />
    </PageLayout>
  );
}
