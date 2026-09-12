import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { History, CheckCircle, XCircle, AlertCircle, Loader2, RotateCcw, Undo2 } from "lucide-react";
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
import { Application, getLiveBuildLog, type Release } from "@/lib/applications";
import { useDeploymentHistory, useReleases, useRestoreRelease } from "@/hooks/useDeployments";
import { locale, t } from "@/lib/i18n";
import { parseAnsi } from "@/lib/ansi";

/** Build output keeps the tools' terminal colors; draw them instead of printing the escapes. */
const AnsiText = ({ text }: { text: string }) => (
  <>
    {parseAnsi(text).map((segment, i) => (
      <span key={i} className={segment.className}>{segment.text}</span>
    ))}
  </>
);

/** Displayed word for a deployment status; the raw value stays for logic. */
const STATUS_LABELS: Record<string, string> = {
  PENDING: t("Pending"),
  BUILDING: t("Building"),
  DEPLOYING: t("Deploying"),
  SUCCESS: t("Succeeded"),
  FAILED: t("Failed"),
  CANCELLED: t("Cancelled"),
};

export const deploymentStatusLabel = (status: string) => STATUS_LABELS[status] ?? status;

const IN_PROGRESS = ["PENDING", "BUILDING", "DEPLOYING"];

// ponytail: a rollback row is known by the text the activate route writes
// (routes/applications.ts). Give Deployment a kind column if that ever changes.
const isRestore = (deployLogs?: string) => !!deployLogs?.startsWith("Switched to the release");

/** Polls the on-disk build log while the deploy runs, pinned to the newest line. */
export function LiveBuildLog({ appId }: { appId: string }) {
  const { data: logs } = useQuery({
    queryKey: ["build-live", appId],
    queryFn: () => getLiveBuildLog(appId),
    refetchInterval: 2000,
  });
  const box = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [logs]);

  return (
    <div className="mt-4 space-y-2">
      <p className="flex items-center gap-2 text-sm font-medium">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("Build log (live)")}
      </p>
      <pre
        ref={box}
        className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs"
      >
        {logs ? <AnsiText text={logs} /> : t("Waiting for output…")}
      </pre>
    </div>
  );
}

/** Asks before switching what is live to a kept build. */
export function RestoreDialog({ appId, isStatic, release, onClose }: { appId: string; isStatic: boolean; release: Release | null; onClose: () => void }) {
  const restore = useRestoreRelease(appId);
  return (
    <AlertDialog open={!!release} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Restore this version?")}</AlertDialogTitle>
          <AlertDialogDescription>
            {isStatic
              ? t("The site switches to these files right away. Nothing is uploaded or rebuilt, and you can switch back at any time.")
              : t("The app stops briefly and restarts on the selected build. Nothing is rebuilt.")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (release) restore.mutate(release);
              onClose();
            }}
          >
            {t("Restore")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface DeploymentHistoryProps {
  application: Application;
}

/**
 * One row per deploy, newest first: what changed, who, when — and on a build
 * that is still kept, Restore. The technical part (commit, duration, logs)
 * opens on a click, for whoever needs it.
 */
export default function DeploymentHistory({ application }: DeploymentHistoryProps) {
  const { data: deploymentData, isLoading, error } = useDeploymentHistory(application.id);
  const { data: releaseData } = useReleases(application.id);
  const [restoring, setRestoring] = useState<Release | null>(null);
  const isStatic = application.type === "STATIC";

  const deployments = deploymentData?.data || [];
  const releaseOf = (deploymentId: string) => releaseData?.releases.find((release) => release.deploymentId === deploymentId);

  const formatDuration = (startTime: string, endTime: string) => {
    const seconds = Math.max(0, Math.round((new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000));
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };

  return (
    <Card className="bg-gradient-card border-border/50">
      <CardHeader>
        <CardTitle className="flex items-center space-x-2">
          <History className="h-5 w-5 text-primary" />
          <span>{t("History")}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-center text-muted-foreground py-8">
            <Loader2 className="h-8 w-8 mx-auto mb-2 animate-spin" />
          </div>
        ) : error ? (
          <div className="text-center text-muted-foreground py-8">
            <AlertCircle className="h-8 w-8 mx-auto mb-2 text-red-500" />
            <p>{t("Error loading deployment history")}</p>
            <p className="text-sm mt-1">{error.message}</p>
          </div>
        ) : deployments.length > 0 ? (
          <div className="divide-y rounded-md border">
            {deployments.map((deployment) => {
              const done = !IN_PROGRESS.includes(deployment.status);
              const failed = deployment.status === "FAILED";
              const restored = isRestore(deployment.deployLogs);
              const release = releaseOf(deployment.id);
              const serving = !!release && release.id === releaseData?.activeReleaseId;
              const canRestore = !!release && !serving && release.status === "READY";
              // what changed, in the words of whoever made the change
              const title = restored
                ? t("Restored an earlier version")
                : deployment.commitMessage || (application.repository ? t("Deploy") : t("Uploaded files"));
              // a failure says why right on the row
              const reason = failed ? deployment.deployLogs?.trim().split("\n")[0] : undefined;
              const who = deployment.user?.name || deployment.user?.email;
              const hasLogs = !!(deployment.deployLogs || deployment.buildLogs);
              return (
                <details key={deployment.id} className="group">
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm hover:bg-muted/50">
                    {failed ? (
                      <XCircle className="h-4 w-4 shrink-0 text-red-500" />
                    ) : !done ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-yellow-500" />
                    ) : deployment.status === "CANCELLED" ? (
                      <AlertCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : restored ? (
                      <Undo2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <CheckCircle className="h-4 w-4 shrink-0 text-green-500" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium" title={title}>{title}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {new Date(deployment.createdAt).toLocaleString(locale)}
                        {who && <> · {who}</>}
                        {reason && <span className="text-destructive"> · {reason}</span>}
                      </p>
                    </div>
                    {serving ? (
                      <Badge>{t("Live now")}</Badge>
                    ) : deployment.status !== "SUCCESS" ? (
                      <Badge variant={failed ? "destructive" : "outline"} className="text-xs">
                        {deploymentStatusLabel(deployment.status)}
                      </Badge>
                    ) : null}
                    {canRestore && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(event) => {
                          // the button sits in <summary>: restore, don't also toggle the row
                          event.preventDefault();
                          setRestoring(release!);
                        }}
                      >
                        <RotateCcw className="mr-2 h-3.5 w-3.5" />
                        {t("Restore")}
                      </Button>
                    )}
                  </summary>

                  {/* for developers: exactly what ran */}
                  <div className="space-y-3 px-3 pb-3 pl-10">
                    <p className="font-mono text-xs text-muted-foreground">
                      {deployment.commitHash && <>{deployment.commitHash.slice(0, 7)} · </>}
                      {done ? formatDuration(deployment.createdAt, deployment.updatedAt) : t("In progress...")}
                    </p>
                    {deployment.deployLogs && (
                      <div className="space-y-1">
                        <p className="text-xs font-medium">{t("Deploy Logs")}</p>
                        <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-xs">
                          <AnsiText text={deployment.deployLogs} />
                        </pre>
                      </div>
                    )}
                    {deployment.buildLogs && (
                      <div className="space-y-1">
                        <p className="text-xs font-medium">{t("Build Logs")}</p>
                        <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-xs">
                          <AnsiText text={deployment.buildLogs} />
                        </pre>
                      </div>
                    )}
                    {!hasLogs && done && <p className="text-xs text-muted-foreground">{t("No logs for this one.")}</p>}
                  </div>
                </details>
              );
            })}
          </div>
        ) : (
          <div className="text-center text-muted-foreground py-8">
            <History className="h-8 w-8 mx-auto mb-2" />
            <p>{t("No deployments yet")}</p>
          </div>
        )}
      </CardContent>

      <RestoreDialog appId={application.id} isStatic={isStatic} release={restoring} onClose={() => setRestoring(null)} />
    </Card>
  );
}
