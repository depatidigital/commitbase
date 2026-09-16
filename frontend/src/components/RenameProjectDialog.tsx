import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { t } from "@/lib/i18n";
import { updateProject, type Project } from "@/lib/projects";
import { updateApplication } from "@/lib/applications";

type Controlled = { open?: boolean; onOpenChange?: (open: boolean) => void };

/**
 * A pencil that opens a one-field rename; `rename` saves and throws on failure.
 * Given `open`, there is no pencil: whoever opens it (a row menu) owns the state.
 */
function RenameDialog({ value, title, description, rename, done, ...controlled }: { value: string; title: string; description?: string; rename: (name: string) => Promise<unknown>; done: string } & Controlled) {
  const { toast } = useToast();
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlled.open ?? ownOpen;
  const setOpen = controlled.onOpenChange ?? setOwnOpen;
  const [name, setName] = useState(value);

  const save = useMutation({
    mutationFn: () => rename(name.trim()),
    onSuccess: () => {
      setOpen(false);
      toast({ title: done });
    },
    onError: (error: Error) => toast({ title: t("Could not rename"), description: error.message, variant: "destructive" }),
  });

  return (
    <>
      {controlled.open === undefined && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 p-0 text-muted-foreground"
          aria-label={title}
          title={title}
          onClick={() => {
            setName(value);
            setOpen(true);
          }}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate();
            }}
          >
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} autoFocus />
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t("Cancel")}
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t("Save")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * A pencil that renames a project. Emptied, the name goes back to the one it
 * gets on its own (its folder, its repository, its first hostname).
 */
export function RenameProjectDialog({ project, ...controlled }: { project: Pick<Project, "id" | "name" | "customName"> } & Controlled) {
  const queryClient = useQueryClient();
  return (
    <RenameDialog
      {...controlled}
      value={project.customName ?? project.name}
      title={t("Rename project")}
      description={t("Leave it empty to name it after its folder or repository again.")}
      done={t("Project renamed")}
      rename={async (name) => {
        await updateProject(project.id, { name });
        void queryClient.invalidateQueries({ queryKey: ["project", project.id] });
        void queryClient.invalidateQueries({ queryKey: ["projects"] });
      }}
    />
  );
}

/** A pencil that renames an app — the name only; its folder and process stay as they are. */
export function RenameAppDialog({ app }: { app: { id: string; name: string } }) {
  const queryClient = useQueryClient();
  return (
    <RenameDialog
      value={app.name}
      title={t("Rename app")}
      done={t("App renamed")}
      rename={async (name) => {
        if (!name) throw new Error(t("A name is needed"));
        await updateApplication(app.id, { name });
        void queryClient.invalidateQueries({ queryKey: ["application"] });
        void queryClient.invalidateQueries({ queryKey: ["project"] });
        void queryClient.invalidateQueries({ queryKey: ["projects"] });
      }}
    />
  );
}
