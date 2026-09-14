import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CheckCircle, Download, FolderGit2, GitBranch, GitCommit, Loader2, Lock, RefreshCw, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { repoName } from "@/lib/applications";
import { getProject, getProjectBranches, pullProject, updateProject } from "@/lib/projects";
import { RenameProjectDialog } from "@/components/RenameProjectDialog";
import { isSuperAdmin } from "@/lib/auth";
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
import { t } from "@/lib/i18n";

interface SourcePanelProps {
  /** the project (source) the page's app — or the page — is about */
  projectId: string;
  /** the page's deploy: saves pending env edits, then starts it (the whole project) */
  onDeploy: () => void;
  starting?: boolean;
  /** a deploy is running — nothing to offer until it ends */
  deploying?: boolean;
}

/**
 * Where the code comes from, in the page's side panel: the project, its
 * branch, a fetch, and whether something newer than what is live is waiting.
 * It is the project's — a pull or deploy here changes every app of it. The
 * deploy button shows only when there is something to ship.
 */
export function SourcePanel({ projectId, onDeploy, starting, deploying }: SourcePanelProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: project } = useQuery({ queryKey: ["project", projectId], queryFn: () => getProject(projectId) });
  const current = project?.branch || "main";
  // an ls-remote, not a clone. Not under ['application', id]: the status poll
  // invalidates that every 2s during a deploy.
  const remote = useQuery({
    queryKey: ["branches", projectId],
    queryFn: () => getProjectBranches(projectId),
    staleTime: 60_000,
    retry: false,
    enabled: !!project?.repository,
  });
  const [branch, setBranch] = useState(current);
  useEffect(() => setBranch(current), [current]);

  // imported by the server sync: the checkout on the box is someone else's, so
  // this only says where the code comes from — no branch switch, no deploy
  const readOnly = project?.kind === "IMPORTED";
  const apps = project?.applications ?? [];
  const changed = branch !== current;
  const head = remote.data?.heads[branch];
  const live = remote.data?.liveCommit ?? null;
  const upToDate = !changed && !!head && head === live;
  // something to ship: another branch picked, or commits the live release lacks
  const shippable = !!head && (changed || head !== live);

  const saveBranch = useMutation({
    mutationFn: () => updateProject(projectId, { branch }),
    onSuccess: () => {
      // the apps, what detection reads, and this comparison all follow the branch
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["application"] });
      void queryClient.invalidateQueries({ queryKey: ["branches", projectId] });
    },
    onError: (error: Error) => toast({ variant: "destructive", title: t("Could not save"), description: error.message }),
  });

  const [confirmPull, setConfirmPull] = useState(false);
  const pull = useMutation({
    mutationFn: () => pullProject(projectId),
    onSuccess: ({ output }) => {
      toast({ title: t("Pulled on the server"), description: output.split("\n").slice(-3).join(" · ") });
      // the server's HEAD moved, and the pull is in the history now
      void queryClient.invalidateQueries({ queryKey: ["branches", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["deployments"] });
    },
    onError: (error: Error) => toast({ variant: "destructive", title: t("Could not pull"), description: error.message }),
  });

  const deployBranch = async () => {
    if (changed) await saveBranch.mutateAsync();
    onDeploy();
  };

  return (
    <Card className="bg-gradient-card border-border/50">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("Source")}</h3>
          {/* ls-remote again: a push a minute ago shows up */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            disabled={remote.isFetching}
            onClick={() => void remote.refetch()}
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${remote.isFetching ? "animate-spin" : ""}`} />
            {t("Fetch")}
          </Button>
        </div>

        {/* the project, renameable here; its page only when it is more than this app */}
        {project && (
          <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
            <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {apps.length > 1 ? (
              <Link to={`/project/${project.id}`} className="flex min-w-0 items-center gap-1.5 hover:text-primary">
                <span className="truncate">{project.name}</span>
                <span className="shrink-0 text-xs font-normal text-muted-foreground">{t("{count} apps", { count: apps.length })}</span>
              </Link>
            ) : (
              <span className="truncate">{project.name}</span>
            )}
            <RenameProjectDialog project={project} />
          </div>
        )}

        <p className="flex min-w-0 items-center gap-1.5 text-sm" title={project?.repository ?? undefined}>
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-xs">{repoName(project?.repository ?? "")}</span>
          {project?.gitAccountId && (
            <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={t("Private — read through a connected account.")} />
          )}
        </p>

        {remote.isLoading ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("Reading the repository…")}
          </p>
        ) : remote.error ? (
          <p className="break-words text-xs text-destructive">{(remote.error as Error).message}</p>
        ) : readOnly ? (
          <>
            <p
              className="text-xs text-muted-foreground"
              title={`${t("Live now")}: ${live?.slice(0, 7) ?? "—"} · ${t("Newest on {branch}", { branch: current })}: ${head?.slice(0, 7) ?? "—"}`}
            >
              {!head || !live
                ? t("Checked out on the server from {branch}. Newest on the remote: {sha}.", { branch: current, sha: head?.slice(0, 7) ?? "—" })
                : head === live
                  ? t("The server has the newest commit on {branch}.", { branch: current })
                  : t("The server is behind {branch}.", { branch: current })}
            </p>
            {/* only the operator touches a server by hand, and only when there is something to pull */}
            {isSuperAdmin() && head && live && head !== live && (
              <Button type="button" variant="outline" className="w-full" disabled={pull.isPending} onClick={() => setConfirmPull(true)}>
                {pull.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
                {t("Pull on server")}
              </Button>
            )}
            <AlertDialog open={confirmPull} onOpenChange={setConfirmPull}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("Pull {branch} on the server?", { branch: current })}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("Runs git pull --ff-only in {dir}. Only the code changes: nothing is installed, built or restarted. It refuses if the server has local changes.", {
                      dir: project?.path ?? "",
                    })}
                    {/* one checkout, several sites: say which ones change */}
                    {apps.length > 1 && (
                      <span className="mt-2 block">
                        {t("It changes all {count} apps of this project: {apps}.", {
                          count: apps.length,
                          apps: apps.map((app) => app.domain).join(", "),
                        })}
                      </span>
                    )}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => pull.mutate()}>{t("Pull on server")}</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : (
          <>
            <Select value={branch} onValueChange={setBranch} disabled={deploying}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* the saved branch stays pickable even if it is gone from the remote */}
                {[...new Set([current, ...(remote.data?.branches ?? [])])].map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                    {name === remote.data?.defaultBranch && (
                      <span className="ml-2 text-xs text-muted-foreground">{t("default")}</span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* live vs newest, in one line a person can act on; the SHAs for whoever hovers */}
            <p
              className="flex items-start gap-1.5 text-xs"
              title={`${t("Live now")}: ${live?.slice(0, 7) ?? "—"} · ${t("Newest on {branch}", { branch })}: ${head?.slice(0, 7) ?? "—"}`}
            >
              {changed ? (
                <span className="text-warning">{t("Switching to {branch} — deploy to put it live.", { branch })}</span>
              ) : !head ? (
                <span className="text-destructive">{t("{branch} is not on the remote anymore.", { branch })}</span>
              ) : upToDate ? (
                <span className="flex items-center gap-1.5 text-success">
                  <CheckCircle className="h-3.5 w-3.5 shrink-0" />
                  {t("Up to date — the newest commit is live.")}
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-warning">
                  <GitCommit className="h-3.5 w-3.5 shrink-0" />
                  {live
                    ? t("New commits on {branch} — pull them to put them live.", { branch })
                    : t("Deploy to put {branch} live.", { branch })}
                </span>
              )}
            </p>

            {shippable && !deploying && (
              <div className="flex flex-col gap-2">
                <Button
                  type="button"
                  className="w-full bg-gradient-primary"
                  disabled={starting || saveBranch.isPending}
                  onClick={() => void deployBranch()}
                >
                  {starting || saveBranch.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : changed || !live ? (
                    <Rocket className="h-4 w-4 mr-2" />
                  ) : (
                    <Download className="h-4 w-4 mr-2" />
                  )}
                  {/* same branch, newer commits: that is a pull. Another branch is a switch */}
                  {changed || !live ? t("Deploy {branch}", { branch }) : t("Pull latest")}
                </Button>
                {changed && (
                  <Button type="button" variant="ghost" size="sm" disabled={saveBranch.isPending} onClick={() => saveBranch.mutate()}>
                    {t("Save branch only")}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
