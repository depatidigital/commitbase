import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
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
import { createUser, getUsers, updateUser, AdminUser } from "@/lib/admin";

const EMPTY_USER = { email: "", name: "", password: "" };

export default function Users() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [newUser, setNewUser] = useState(EMPTY_USER);

  const onError = (error: Error) =>
    toast({
      title: "Error",
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
        title: "User created",
        description: "Invite them to an organization from the Team page.",
      });
    },
    onError,
  });

  const toggleActive = useMutation({
    mutationFn: ({ user, isActive }: { user: AdminUser; isActive: boolean }) =>
      updateUser(user.id, { isActive }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      toast({ title: "User updated" });
    },
    onError,
  });

  const columns: Column<AdminUser>[] = [
    {
      header: "User",
      cell: (u) => (
        <>
          <div className="font-medium">{u.name || u.email}</div>
          <div className="text-xs text-muted-foreground">{u.email}</div>
        </>
      ),
    },
    {
      header: "Platform role",
      cell: (u) => (
        <Badge variant={u.role === "ADMIN" ? "default" : "secondary"}>
          {u.role}
        </Badge>
      ),
    },
    {
      header: "Organizations",
      className: "space-x-1",
      cell: (u) =>
        u.memberships.length === 0 ? (
          <span className="text-xs text-muted-foreground">none</span>
        ) : (
          u.memberships.map((m) => (
            <Badge key={m.organization.id} variant="outline">
              {m.organization.name} · {m.role}
            </Badge>
          ))
        ),
    },
    {
      header: "Active",
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
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <UsersIcon className="h-5 w-5" /> Users
          </h1>
          <p className="text-sm text-muted-foreground">
            Client accounts on the platform and their organization memberships.
          </p>
        </div>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" /> New user
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New client account</DialogTitle>
              <DialogDescription>
                They sign in with this temporary password and must change it on
                first login.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
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
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={newUser.name}
                  onChange={(e) =>
                    setNewUser({ ...newUser, name: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Temporary password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="min 8 characters"
                  value={newUser.password}
                  onChange={(e) =>
                    setNewUser({ ...newUser, password: e.target.value })
                  }
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
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
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <DataTable
        columns={columns}
        rows={data?.data ?? []}
        rowKey={(u) => u.id}
        query={query}
        pagination={data?.pagination}
        isLoading={isFetching}
        searchPlaceholder="Search email or name…"
        empty="No users found."
      />
    </div>
  );
}
