import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { t } from "@/lib/i18n";
import { addProjectMember, getProjectMembers, removeProjectMember, type ProjectUser } from "@/lib/projects";

const label = (user: ProjectUser) => user.name || user.email;

function Person({ user, badge, action }: { user: ProjectUser; badge?: string; action?: React.ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{label(user)}</p>
        {user.name && <p className="truncate text-xs text-muted-foreground">{user.email}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {badge && <Badge variant="secondary">{badge}</Badge>}
        {action}
      </div>
    </li>
  );
}

/**
 * Who sees the project: the org's owners/admins (always), its creator, and the
 * members added. View-only; "Kelola" opens the dialog where members are added/removed.
 */
export function ProjectMembersCard({ projectId }: { projectId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState("");
  const { data } = useQuery({ queryKey: ["project-members", projectId], queryFn: () => getProjectMembers(projectId) });

  const done = () => queryClient.invalidateQueries({ queryKey: ["project-members", projectId] });
  const fail = (error: Error) => toast({ variant: "destructive", title: t("Something went wrong"), description: error.message });
  const add = useMutation({
    mutationFn: (userId: string) => addProjectMember(projectId, userId),
    onSuccess: () => {
      setPicked("");
      void done();
    },
    onError: fail,
  });
  const remove = useMutation({ mutationFn: (userId: string) => removeProjectMember(projectId, userId), onSuccess: done, onError: fail });

  if (!data) return null;
  const roleLabel = (role: string) => (role === "OWNER" ? t("Org owner") : t("Org admin"));
  const fixed = (
    <>
      {data.admins.map((user) => (
        <Person key={user.id} user={user} badge={roleLabel(user.role)} />
      ))}
      {data.creator && !data.admins.some((admin) => admin.id === data.creator!.id) && <Person user={data.creator} badge={t("Creator")} />}
    </>
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5" />
          {t("Members")}
        </CardTitle>
        {data.canManage && (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            {t("Manage")}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <p className="mb-2 text-sm text-muted-foreground">
          {t("Owners and admins of the workspace always see this app. Other members only see it once added here.")}
        </p>
        <ul className="divide-y">
          {fixed}
          {data.members.map((user) => (
            <Person key={user.id} user={user} badge={t("Member")} />
          ))}
        </ul>
        {data.members.length === 0 && <p className="pt-2 text-sm text-muted-foreground">{t("No members added yet.")}</p>}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("App members")}</DialogTitle>
            <DialogDescription>{t("Members added here can see, deploy and configure every service of this app.")}</DialogDescription>
          </DialogHeader>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (picked) add.mutate(picked);
            }}
          >
            <Select value={picked} onValueChange={setPicked} disabled={data.candidates.length === 0}>
              <SelectTrigger className="flex-1">
                <SelectValue placeholder={data.candidates.length ? t("Pick a workspace member") : t("Every workspace member is already in")} />
              </SelectTrigger>
              <SelectContent>
                {data.candidates.map((user) => (
                  <SelectItem key={user.id} value={user.id}>
                    {label(user)}
                    {user.name ? ` · ${user.email}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" disabled={!picked || add.isPending}>
              {add.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("Add")}
            </Button>
          </form>
          <ul className="max-h-80 divide-y overflow-y-auto">
            {fixed}
            {data.members.map((user) => (
              <Person
                key={user.id}
                user={user}
                badge={t("Member")}
                action={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                    aria-label={t("Remove")}
                    title={t("Remove")}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(user.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                }
              />
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
