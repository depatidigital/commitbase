import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { t } from "@/lib/i18n";
import { updateProject, type Project } from "@/lib/projects";

/**
 * A pencil that renames a project. Emptied, the name goes back to the one it
 * gets on its own (its folder, its repository, its first hostname).
 */
export function RenameProjectDialog({ project }: { project: Pick<Project, "id" | "name" | "customName"> }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  const rename = useMutation({
    mutationFn: () => updateProject(project.id, { name: name.trim() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project", project.id] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      setOpen(false);
      toast({ title: t("Project renamed") });
    },
    onError: (error: Error) => toast({ title: t("Could not rename the project"), description: error.message, variant: "destructive" }),
  });

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 w-7 shrink-0 p-0 text-muted-foreground"
        aria-label={t("Rename project")}
        title={t("Rename project")}
        onClick={() => {
          setName(project.customName ?? project.name);
          setOpen(true);
        }}
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Rename project")}</DialogTitle>
            <DialogDescription>{t("Leave it empty to name it after its folder or repository again.")}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              rename.mutate();
            }}
          >
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} autoFocus />
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t("Cancel")}
              </Button>
              <Button type="submit" disabled={rename.isPending}>
                {rename.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t("Save")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
