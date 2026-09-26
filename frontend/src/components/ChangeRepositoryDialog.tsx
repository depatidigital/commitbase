import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2, Lock, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RepositoryCombobox } from "@/components/RepositoryCombobox";
import { useToast } from "@/hooks/use-toast";
import { listRepositoryBranches } from "@/lib/applications";
import { t } from "@/lib/i18n";
import { changeProjectRepository, type Project } from "@/lib/projects";

/**
 * A pencil that points the app at its repository's new URL, picked like on the
 * add-app form: the account that can read it comes along. The server checks
 * that what is live is in the new URL's history and refuses otherwise — the
 * error says which commit is missing.
 */
export function ChangeRepositoryDialog({ project }: { project: Pick<Project, "id" | "repository" | "branch" | "kind"> }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(project.repository ?? "");
  const branch = project.branch || "main";
  const changed = !!url.trim() && url.trim() !== project.repository;
  // an imported checkout reads it with its server's credentials: checked there, on save
  const imported = project.kind === "IMPORTED";

  // which connected account reads it (none: public), and whether the branch is there
  const lookup = useQuery({
    queryKey: ["repository-branches", url.trim()],
    queryFn: () => listRepositoryBranches(url.trim()),
    enabled: open && changed && !imported,
    retry: false,
  });
  const found = lookup.data && !lookup.data.needsAccount;
  const noBranch = found && !lookup.data!.branches.includes(branch);

  const save = useMutation({
    mutationFn: () => changeProjectRepository(project.id, url.trim(), lookup.data?.gitAccountId ?? null),
    onSuccess: () => {
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["project", project.id] });
      void queryClient.invalidateQueries({ queryKey: ["branches", project.id] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast({ title: t("Repository changed"), description: t("The next pull or deploy fetches from the new URL.") });
    },
  });

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 w-7 shrink-0 p-0 text-muted-foreground"
        aria-label={t("Change repository")}
        title={t("Change repository")}
        onClick={() => {
          setUrl(project.repository ?? "");
          save.reset();
          setOpen(true);
        }}
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={(next) => !save.isPending && setOpen(next)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Change repository")}</DialogTitle>
            <DialogDescription>
              {t("For a repository that moved or was renamed. The new URL must have the same history: the live commit has to be in its {branch} branch.", { branch })}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate();
            }}
          >
            <div className="space-y-1.5">
              <RepositoryCombobox value={url} onChange={(next) => {
                  save.reset();
                  setUrl(next);
                }} />
              {changed &&
                !imported &&
                (lookup.isFetching ? (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t("Checking the repository…")}
                  </p>
                ) : lookup.isError ? (
                  <p className="flex items-center gap-1.5 text-xs text-destructive">
                    <AlertCircle className="h-3 w-3" />
                    {t("This repository cannot be read. Check the URL — a private repository has to be on GitHub or GitLab.")}
                  </p>
                ) : lookup.data?.needsAccount ? (
                  <p className="flex items-center gap-1.5 text-xs text-destructive">
                    <AlertCircle className="h-3 w-3" />
                    {t("None of your connected {provider} accounts can read it. Connect one that can in Settings.", {
                      provider: lookup.data.needsAccount === "github" ? "GitHub" : "GitLab",
                    })}
                  </p>
                ) : noBranch ? (
                  <p className="flex items-center gap-1.5 text-xs text-destructive">
                    <AlertCircle className="h-3 w-3" />
                    {t("It has no {branch} branch.", { branch })}
                  </p>
                ) : lookup.data?.gitAccountId ? (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Lock className="h-3 w-3" />
                    {t("Private repository — read and deployed through your connected account.")}
                  </p>
                ) : null)}
            </div>
            {save.error && <p className="whitespace-pre-wrap break-words text-sm text-destructive">{save.error.message}</p>}
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={save.isPending}>
                {t("Cancel")}
              </Button>
              <Button type="submit" disabled={save.isPending || !changed || (!imported && (!found || noBranch))}>
                {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {save.isPending ? t("Checking history…") : t("Check and save")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
