import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, Download, GitBranch, GitCommit, Loader2, Lock, RefreshCw, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Application, getAppBranches, updateApplication } from "@/lib/applications";
import { t } from "@/lib/i18n";

/** owner/repo out of a clone URL — the part a person recognises */
const shortName = (url: string) => url.replace(/\.git$/, "").split(/[/:]/).slice(-2).join("/");

interface SourcePanelProps {
  application: Application;
  /** the page's deploy: saves pending env edits, then starts it */
  onDeploy: () => void;
  starting?: boolean;
  /** a deploy is running — nothing to offer until it ends */
  deploying?: boolean;
}

/**
 * Where the code comes from, in the page's side panel: the branch, a fetch,
 * and whether something newer than what is live is waiting. The deploy button
 * shows only when there is — an up-to-date app redeploys from the menu.
 */
export function SourcePanel({ application, onDeploy, starting, deploying }: SourcePanelProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const current = application.branch || "main";
  // an ls-remote, not a clone. Not under ['application', id]: the status poll
  // invalidates that every 2s during a deploy.
  const remote = useQuery({
    queryKey: ["branches", application.id],
    queryFn: () => getAppBranches(application.id),
    staleTime: 60_000,
    retry: false,
  });
  const [branch, setBranch] = useState(current);
  useEffect(() => setBranch(current), [current]);

  const changed = branch !== current;
  const head = remote.data?.heads[branch];
  const live = remote.data?.liveCommit ?? null;
  const upToDate = !changed && !!head && head === live;
  // something to ship: another branch picked, or commits the live release lacks
  const shippable = !!head && (changed || head !== live);

  const saveBranch = useMutation({
    mutationFn: () => updateApplication(application.id, { branch }),
    onSuccess: () => {
      // the app row, what detection reads, and this comparison all follow the branch
      void queryClient.invalidateQueries({ queryKey: ["application", application.id] });
      void queryClient.invalidateQueries({ queryKey: ["branches", application.id] });
    },
    onError: (error: Error) => toast({ variant: "destructive", title: t("Could not save"), description: error.message }),
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

        <p className="flex min-w-0 items-center gap-1.5 text-sm" title={application.repository ?? undefined}>
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-xs">{shortName(application.repository ?? "")}</span>
          {application.gitAccountId && (
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
