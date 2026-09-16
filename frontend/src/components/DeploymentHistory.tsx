import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { restoreDatabaseSnapshot } from "@/lib/databases";
import { History, CheckCircle, XCircle, AlertCircle, Loader2, RotateCcw, Square, Undo2 } from "lucide-react";
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Application, getLiveBuildLog, type Release } from "@/lib/applications";
import type { Deployment } from "@/lib/deployments";
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

const formatDuration = (startTime: string, endTime: string) => {
  const seconds = Math.max(0, Math.round((new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

/** What changed, in the words of whoever made the change. */
const deployTitle = (deployment: Deployment, fromRepository: boolean) =>
  isRestore(deployment.deployLogs)
    ? t("Restored an earlier version")
    : deployment.commitMessage || (fromRepository ? t("Deploy") : t("Uploaded files"));

function DeployIcon({ deployment }: { deployment: Deployment }) {
  if (deployment.status === "FAILED") return <XCircle className="h-4 w-4 shrink-0 text-red-500" />;
  if (IN_PROGRESS.includes(deployment.status)) return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-yellow-500" />;
  if (deployment.status === "CANCELLED") return <AlertCircle className="h-4 w-4 shrink-0 text-muted-foreground" />;
  if (isRestore(deployment.deployLogs)) return <Undo2 className="h-4 w-4 shrink-0 text-muted-foreground" />;
  return <CheckCircle className="h-4 w-4 shrink-0 text-green-500" />;
}

/**
 * Polls the on-disk build log while the deploy runs, pinned to the newest line.
 * `text`: a log the caller already follows instead — an imported pm2 app's
 * build writes onto its deployment row, not into a build log on disk.
 */
export function LiveBuildLog({ appId, text }: { appId: string; text?: string | undefined }) {
  const { data: fetched } = useQuery({
    queryKey: ["build-live", appId],
    queryFn: () => getLiveBuildLog(appId),
    refetchInterval: 2000,
    enabled: text === undefined,
  });
  const logs = text ?? fetched;
  const box = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [logs]);

  return (
    <div className="mt-3 space-y-2">
      <p className="flex items-center gap-2 text-sm font-medium">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("Build log (live)")}
      </p>
      {/* a fixed height, not a max: the box does not grow line by line and push the page down */}
      <pre
        ref={box}
        className="h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs"
      >
        {logs ? <AnsiText text={logs} /> : t("Waiting for output…")}
      </pre>
    </div>
  );
}

type Snapshot = NonNullable<Deployment["snapshots"]>[number];

/**
 * The app's databases as they were before this deploy's migrations, each with
 * the way back. Asked by name first: everything written since is lost.
 */
function SnapshotRestore({ snapshots }: { snapshots: Snapshot[] }) {
  const [picked, setPicked] = useState<Snapshot | null>(null);
  const [typed, setTyped] = useState("");
  const { toast } = useToast();
  const restore = useMutation({
    mutationFn: (s: Snapshot) => restoreDatabaseSnapshot(s.databaseId, s.file, s.dbName),
    onSuccess: (_, s) => {
      toast({ title: t("Restoring {db}", { db: s.dbName }), description: t("Follow it on the Database tab.") });
      setPicked(null);
    },
    onError: (error: Error) => toast({ variant: "destructive", title: t("Could not start the restore"), description: error.message }),
  });
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">{t("Database before this deploy:")}</span>
      {snapshots.map((snapshot) => (
        <Button
          key={snapshot.file}
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            setTyped("");
            setPicked(snapshot);
          }}
        >
          <Undo2 className="mr-1.5 h-3 w-3" />
          {t("Restore {db}", { db: snapshot.dbName })}
        </Button>
      ))}
      <AlertDialog open={!!picked} onOpenChange={(open) => !open && !restore.isPending && setPicked(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Restore {db} to before this deploy?", { db: picked?.dbName ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("The database goes back to its snapshot of {when}. Everything written since then is lost. Type the database's name to confirm.", {
                when: picked ? new Date(picked.createdAt).toLocaleString(locale) : "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={picked?.dbName} disabled={restore.isPending} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restore.isPending}>{t("Cancel")}</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={!picked || typed.trim() !== picked.dbName || restore.isPending}
              onClick={() => picked && restore.mutate(picked)}
            >
              {restore.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("Restore database")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * The last few lines of a running build, for a card that has no room for the
 * whole log: the same live query the dialog uses, so following it costs one
 * request. Clicking opens the whole thing.
 */
export function BuildLogTail({
  appId,
  text,
  lines = 3,
  onOpen,
}: {
  appId: string;
  /** an imported app's build writes onto its deployment row, not into a build log on disk */
  text?: string | undefined;
  lines?: number;
  onOpen?: () => void;
}) {
  const { data } = useQuery({
    queryKey: ["build-live", appId],
    queryFn: () => getLiveBuildLog(appId),
    refetchInterval: 2000,
    enabled: text === undefined,
  });
  const tail = (text ?? data ?? "")
    .split("\n")
    .filter((line) => line.trim())
    .slice(-lines)
    .join("\n");

  const body = (
    <pre className="overflow-hidden whitespace-pre-wrap break-all rounded bg-muted/60 p-2 text-left font-mono text-[11px] leading-snug text-muted-foreground">
      {tail ? <AnsiText text={tail} /> : t("Waiting for output…")}
    </pre>
  );
  return onOpen ? (
    <button type="button" onClick={onOpen} title={t("Full log")} className="block w-full hover:opacity-80">
      {body}
    </button>
  ) : (
    body
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
  /** any app of the project: the history is its whole source's */
  application: Pick<Application, "id" | "type" | "repository">;
  /** several apps share the history: each row names the one it was started from */
  showApp?: boolean;
  /** only the deploys of this app — the history is its source's, every app of it */
  onlyApp?: string;
}

/**
 * One row per deploy, newest first: what changed, who, when — and on a build
 * that is still kept, Restore. The technical part (commit, duration, logs)
 * opens on a click, for whoever needs it.
 */
export default function DeploymentHistory({ application, showApp = false, onlyApp }: DeploymentHistoryProps) {
  const { data: deploymentData, isLoading, error } = useDeploymentHistory(application.id);
  const { data: releaseData } = useReleases(application.id);
  const [restoring, setRestoring] = useState<Release | null>(null);
  const isStatic = application.type === "STATIC";

  const deployments = (deploymentData?.data || []).filter((deployment) => !onlyApp || deployment.applicationId === onlyApp);
  const releaseOf = (deploymentId: string) => releaseData?.releases.find((release) => release.deploymentId === deploymentId);

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
              const release = releaseOf(deployment.id);
              const serving = !!release && release.id === releaseData?.activeReleaseId;
              const canRestore = !!release && !serving && release.status === "READY";
              const title = deployTitle(deployment, !!application.repository);
              // a failure says why right on the row
              const reason = failed ? deployment.deployLogs?.trim().split("\n")[0] : undefined;
              const who = deployment.user?.name || deployment.user?.email;
              const hasLogs = !!(deployment.deployLogs || deployment.buildLogs);
              return (
                <details key={deployment.id} className="group">
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm hover:bg-muted/50">
                    <DeployIcon deployment={deployment} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium" title={title}>{title}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {showApp && deployment.application && <>{deployment.application.name} · </>}
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
                    {!!deployment.snapshots?.length && done && <SnapshotRestore snapshots={deployment.snapshots} />}
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

/**
 * One app's deploys in a dialog: the list on the left, the picked deploy's log
 * filling the right — the running one's live, pinned to its newest line. Opens
 * on the running deploy, else the newest: a failure is its log, straight away.
 * ponytail: the database-snapshot restore stays on the app page's history.
 */
export function DeployLogDialog({
  application,
  open,
  onOpenChange,
  onCancel,
  cancelling = false,
}: {
  application: Pick<Application, "id" | "name" | "type" | "repository" | "runtime">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** the panel's own deploy stops at its next step: given, the running one gets Cancel */
  onCancel?: () => void;
  cancelling?: boolean;
}) {
  const { data } = useDeploymentHistory(application.id);
  const { data: releaseData } = useReleases(application.id);
  const [restoring, setRestoring] = useState<Release | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  // opened again: back on the running (or newest) one
  useEffect(() => {
    if (!open) setPicked(null);
  }, [open]);

  // the history is the source's, every app of it: this app's
  const deployments = (data?.data ?? []).filter((deployment) => deployment.applicationId === application.id);
  const selected =
    deployments.find((deployment) => deployment.id === picked) ??
    deployments.find((deployment) => IN_PROGRESS.includes(deployment.status)) ??
    deployments[0];
  const releaseOf = (deploymentId: string) => releaseData?.releases.find((release) => release.deploymentId === deploymentId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* flex, not the dialog's default grid: an auto grid column grows to the longest unbroken line and nothing truncates */}
      <DialogContent className="flex h-[85vh] max-w-5xl flex-col gap-4">
        <DialogHeader>
          <DialogTitle>
            {t("Deployments")} — {application.name}
          </DialogTitle>
        </DialogHeader>
        {deployments.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground">
            {data ? (
              <>
                <History className="mb-2 h-8 w-8" />
                <p>{t("No deployments yet")}</p>
              </>
            ) : (
              <Loader2 className="h-6 w-6 animate-spin" />
            )}
          </div>
        ) : (
          // phone: the list above (a few rows high), the log under it; wider: side by side, both the full height
          <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-3 md:grid-cols-[17rem_minmax(0,1fr)] md:grid-rows-1">
            <ul className="max-h-40 min-w-0 divide-y overflow-y-auto rounded-md border md:max-h-none">
              {deployments.map((deployment) => {
                const release = releaseOf(deployment.id);
                const serving = !!release && release.id === releaseData?.activeReleaseId;
                const canRestore = !!release && !serving && release.status === "READY";
                const title = deployTitle(deployment, !!application.repository);
                const who = deployment.user?.name || deployment.user?.email;
                return (
                  <li
                    key={deployment.id}
                    className={`flex items-center gap-2 pr-2 text-sm ${deployment.id === selected?.id ? "bg-muted" : "hover:bg-muted/50"}`}
                  >
                    <button
                      type="button"
                      aria-current={deployment.id === selected?.id}
                      onClick={() => setPicked(deployment.id)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-3 text-left"
                    >
                      <DeployIcon deployment={deployment} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium" title={title}>{title}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {new Date(deployment.createdAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}
                          {who && <> · {who}</>}
                        </span>
                      </span>
                    </button>
                    {serving ? (
                      <Badge className="shrink-0 text-[10px]">{t("Live now")}</Badge>
                    ) : canRestore ? (
                      <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={() => setRestoring(release!)}>
                        <RotateCcw className="mr-1 h-3 w-3" />
                        {t("Restore")}
                      </Button>
                    ) : deployment.status !== "SUCCESS" ? (
                      <Badge variant={deployment.status === "FAILED" ? "destructive" : "outline"} className="shrink-0 text-[10px]">
                        {deploymentStatusLabel(deployment.status)}
                      </Badge>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {selected && (
              <DeployLogPane key={selected.id} application={application} deployment={selected} onCancel={onCancel} cancelling={cancelling} />
            )}
          </div>
        )}
        <RestoreDialog appId={application.id} isStatic={application.type === "STATIC"} release={restoring} onClose={() => setRestoring(null)} />
      </DialogContent>
    </Dialog>
  );
}

/** One deploy's log, the height it is given: what ran, how long, and its output. */
function DeployLogPane({
  application,
  deployment,
  onCancel,
  cancelling,
}: {
  application: Pick<Application, "id" | "runtime">;
  deployment: Deployment;
  onCancel?: () => void;
  cancelling: boolean;
}) {
  const running = IN_PROGRESS.includes(deployment.status);
  // queued: build.log is still the previous deploy's — not shown as if it were this one's.
  // An imported app's build writes onto its deployment row, not into a build log on disk
  const onDisk = running && deployment.status !== "PENDING" && !application.runtime;
  const { data: live } = useQuery({
    queryKey: ["build-live", application.id],
    queryFn: () => getLiveBuildLog(application.id),
    refetchInterval: 2000,
    enabled: onDisk,
  });
  const text = onDisk ? live ?? "" : [deployment.deployLogs, deployment.buildLogs].filter((part) => part?.trim()).join("\n\n");

  // following a running one: pinned to the newest line as it prints
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (running && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [running, text]);

  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <DeployIcon deployment={deployment} />
        <span className="font-medium text-foreground">{deploymentStatusLabel(deployment.status)}</span>
        {deployment.commitHash && <span className="font-mono">{deployment.commitHash.slice(0, 7)}</span>}
        <span>{running ? t("In progress...") : formatDuration(deployment.createdAt, deployment.updatedAt)}</span>
        {running && onCancel && (
          <Button variant="ghost" size="sm" className="ml-auto h-7 text-destructive hover:text-destructive" disabled={cancelling} onClick={onCancel}>
            <Square className="mr-1.5 h-3.5 w-3.5" />
            {t("Cancel deploy")}
          </Button>
        )}
      </div>
      {/* the databases as they were before this deploy's migrations — once it is done */}
      {!running && !!deployment.snapshots?.length && <SnapshotRestore snapshots={deployment.snapshots} />}
      <pre ref={box} className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs">
        {deployment.status === "PENDING" ? (
          t("Waiting for its turn — the log appears once the build starts.")
        ) : text ? (
          <AnsiText text={text} />
        ) : running ? (
          t("Waiting for output…")
        ) : (
          t("No logs for this one.")
        )}
      </pre>
    </div>
  );
}
