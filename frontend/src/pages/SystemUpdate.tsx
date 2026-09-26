import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { PageLayout } from "@/components/PageLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { t } from "@/lib/i18n";
import { getSystemUpdate, startSystemUpdate } from "@/lib/system";
import { timeAgo } from "@/lib/utils";

/**
 * Update Larika itself (superadmin): pull main, build beside the live
 * release, wait for running deploys, restart, roll back if it does not come
 * up — larika-upgrade.sh on the server. The page keeps polling through the
 * restart, so the log reads to the end.
 */
export default function SystemUpdate() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // until the unit shows up, and through the restart, keep asking
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<"update" | "rollback" | null>(null);
  const [fetchRemote, setFetchRemote] = useState(true);

  const status = useQuery({
    queryKey: ["system-update", fetchRemote],
    queryFn: () => getSystemUpdate(fetchRemote),
    refetchInterval: (query) => {
      const data = query.state.data;
      const recent = startedAt !== null && Date.now() - startedAt < 60_000;
      return (data?.supported && data.running) || recent || (startedAt !== null && query.state.status === "error") ? 2000 : false;
    },
    retry: startedAt !== null ? 30 : 1,
  });
  const data = status.data?.supported ? status.data : null;

  // the version this tab was loaded with: when the live one differs, the tab is old
  const loadedWith = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (data && loadedWith.current === undefined) loadedWith.current = data.current?.label ?? null;
  }, [data]);
  const replaced = !!data && loadedWith.current !== undefined && (data.current?.label ?? null) !== loadedWith.current;

  const start = useMutation({
    mutationFn: (action: "update" | "rollback") => startSystemUpdate(action),
    onSuccess: (_, action) => {
      setStartedAt(Date.now());
      setFetchRemote(false);
      toast({ title: action === "rollback" ? t("Rollback started") : t("Update started") });
      void queryClient.invalidateQueries({ queryKey: ["system-update"] });
    },
    onError: (error: Error) => toast({ title: t("Could not start"), description: error.message, variant: "destructive" }),
  });

  const running = !!data?.running;
  // unanswered during the restart: expected, not an error to show
  const restarting = startedAt !== null && status.isError;

  return (
    <PageLayout
      icon={ArrowUpCircle}
      title={t("Update Larika")}
      description={t("Pull the newest {branch}, build it beside the running version and switch over. Deploys are not interrupted.", { branch: data?.branch ?? "main" })}
      actions={
        data && (
          <Button
            variant="outline"
            disabled={status.isFetching || running}
            onClick={() => {
              setFetchRemote(true);
              void queryClient.invalidateQueries({ queryKey: ["system-update", true] });
            }}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${status.isFetching ? "animate-spin" : ""}`} />
            {t("Check for updates")}
          </Button>
        )
      }
    >
      {status.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("Checking…")}
        </p>
      ) : status.data && !status.data.supported ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            {t("This panel is not installed with larika-upgrade.sh (/opt/larika/current), so it cannot update itself from here.")}
          </CardContent>
        </Card>
      ) : !data ? (
        <Card>
          <CardContent className="pt-6 text-sm text-destructive">{(status.error as Error | null)?.message}</CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {replaced && !running && (
            <Card className="border-primary">
              <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
                <span className="text-sm">{t("Larika now runs {version}. Reload to use it.", { version: data.current?.label ?? "" })}</span>
                <Button onClick={() => window.location.reload()}>{t("Reload")}</Button>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("Running")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <span className="font-mono">{data.current?.label ?? "—"}</span>
                {data.current?.subject && <span className="ml-2">{data.current.subject}</span>}
                {data.current?.date && <span className="ml-2 text-muted-foreground">{timeAgo(data.current.date)}</span>}
              </div>
              {data.previous && (
                <div className="flex flex-wrap items-center gap-3 text-muted-foreground">
                  <span>
                    {t("Before it:")} <span className="font-mono">{data.previous.label}</span>
                    {data.previous.subject && <span className="ml-2">{data.previous.subject}</span>}
                  </span>
                  <Button variant="outline" size="sm" disabled={running || start.isPending} onClick={() => setConfirm("rollback")}>
                    <RotateCcw className="mr-2 h-3.5 w-3.5" />
                    {t("Roll back")}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">
                {data.pending.length
                  ? t("{count} new on {branch}", { count: data.pending.length, branch: data.branch })
                  : t("Up to date with {branch}", { branch: data.branch })}
              </CardTitle>
              <Button disabled={!data.pending.length || running || start.isPending} onClick={() => setConfirm("update")}>
                {running || start.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowUpCircle className="mr-2 h-4 w-4" />}
                {running ? t("Updating…") : t("Update now")}
              </Button>
            </CardHeader>
            {data.pending.length > 0 && (
              <CardContent>
                <ul className="divide-y text-sm">
                  {data.pending.map((commit) => (
                    <li key={commit.sha} className="flex items-baseline gap-3 py-2">
                      <span className="font-mono text-xs text-muted-foreground">{commit.sha.slice(0, 7)}</span>
                      <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {commit.author} · {timeAgo(commit.date)}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            )}
          </Card>

          {(running || restarting || data.log) && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  {(running || restarting) && <Loader2 className="h-4 w-4 animate-spin" />}
                  {restarting ? t("Larika is restarting…") : running ? t("Update log") : t("Last update log")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs">{data.log || "…"}</pre>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "rollback" ? t("Roll back Larika?") : t("Update Larika now?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "rollback"
                ? t("Larika switches back to {version} and restarts. Database changes made since stay.", { version: data?.previous?.label ?? "" })
                : t("The new version is built while this one keeps running. Then running deploys finish, new ones wait, and Larika restarts for a few seconds. If it does not come up, the current version is put back.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirm) start.mutate(confirm);
                setConfirm(null);
              }}
            >
              {confirm === "rollback" ? t("Roll back") : t("Update now")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageLayout>
  );
}
