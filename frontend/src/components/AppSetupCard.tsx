import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Input } from "@/components/ui/input";
import { AlertTriangle, CheckCircle, Circle, Database, Globe, KeyRound, Layers, Loader2, Rocket, RotateCcw, Settings, SkipForward, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { EnvStatus } from "@/components/AppEnvironment";
import { useToast } from "@/hooks/use-toast";
import { Application, DetectedProject, hostsOf, updateApplication, type StartOptions } from "@/lib/applications";
import { t } from "@/lib/i18n";
import { ComposePreview } from "@/components/ComposePreview";

interface AppSetupCardProps {
  application: Application;
  detected?: DetectedProject | null;
  detecting: boolean;
  /** the Environment tab's form as it stands */
  env: EnvStatus;
  /** the saved DATABASE_URL tried from the app's node: running, its outcome, or not tried */
  dbCheck?: "pending" | { ok: boolean; message: string } | null;
  /** why the last deploy failed — Deploy is then the retry */
  failure?: string;
  /** the Prisma migration the last deploy found recorded as failed (P3009): offered to be cleared and retried */
  failedMigration?: string | null;
  /** Deploy was clicked and is saving or starting */
  starting?: boolean;
  onDeploy: (options?: StartOptions) => void;
  /** the hosts dialog — the first step: the env's addresses follow from them */
  onEditHosts: () => void;
  onEditEnv: () => void;
  onEditBuild: () => void;
  /** one line a step, in a small box — the project page's app cards */
  compact?: boolean;
  /** compact: the deploy's whole log, in the card's dialog */
  onShowLog?: () => void;
}

/**
 * What a failed deploy's migrations can be met with, under the failure: the
 * failed record cleared and run again (P3009), recorded as applied (a baseline),
 * or the database emptied after a snapshot. Same on the setup checklist and the
 * app page's failure card.
 */
export function DeployFailureFixes({ application, failure, failedMigration, starting, onDeploy }: Pick<AppSetupCardProps, "application" | "failure" | "failedMigration" | "starting" | "onDeploy">) {
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmApplied, setConfirmApplied] = useState(false);
  const [confirmDataLoss, setConfirmDataLoss] = useState(false);
  const [typed, setTyped] = useState("");
  // prisma db push stopped short of a change that drops data (a column, a table, a unique on duplicates)
  const dataLoss = !!failure && /--accept-data-loss/.test(failure);
  const aboutMigrations = !!failure && (!!failedMigration || dataLoss || /migrat|relation .* does not exist/i.test(failure));
  if (!aboutMigrations) return null;

  // one row an option: what is done on the left, why one would on the right
  const option = (button: React.ReactNode, detail: string) => (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="w-full sm:w-64 shrink-0">{button}</span>
      <span className="min-w-0 flex-1 text-muted-foreground">{detail}</span>
    </li>
  );
  const button = (label: string, icon: React.ReactNode, onClick: () => void, destructive = false) => (
    <Button type="button" variant="outline" size="sm" className={`h-7 w-full justify-start text-xs ${destructive ? "text-destructive hover:text-destructive" : ""}`} disabled={starting} onClick={onClick}>
      {icon}
      {label}
    </Button>
  );

  return (
    <div className="space-y-2 text-xs">
      <p className="font-medium">
        {failedMigration
          ? t("Migration {name} is recorded as failed and blocks the rest.", { name: failedMigration })
          : dataLoss
            ? t("prisma db push stopped: the schema change would delete data.")
            : t("The migrations failed.")}{" "}
        <span className="font-normal text-muted-foreground">{t("Ways out:")}</span>
      </p>
      <ol className="space-y-1.5">
        {failedMigration &&
          option(
            button(t("Clear it and deploy again"), <RotateCcw className="mr-1.5 h-3 w-3" />, () => onDeploy({ resolveMigration: failedMigration })),
            t("Its record is cleared and it runs again. When it failed for a passing reason."),
          )}
        {failedMigration &&
          option(
            button(t("Mark it as applied and deploy"), <CheckCircle className="mr-1.5 h-3 w-3" />, () => setConfirmApplied(true)),
            t("Not run, recorded as done. When its tables are already there — a squashed history."),
          )}
        {dataLoss &&
          option(
            button(t("Accept the data loss and deploy"), <AlertTriangle className="mr-1.5 h-3 w-3" />, () => setConfirmDataLoss(true), true),
            t("Pushed with --accept-data-loss this once, after a snapshot. When the dropped columns or rows are not needed."),
          )}
        {option(
          button(t("Deploy without the migrations"), <SkipForward className="mr-1.5 h-3 w-3" />, () => onDeploy({ skipPreDeploy: true })),
          t("The pre-deploy step is left out this once; the code goes live on the schema as it is. When the code does not need the change yet."),
        )}
        {option(
          button(t("Reset the database and deploy"), <Database className="mr-1.5 h-3 w-3" />, () => setConfirmReset(true), true),
          t("Emptied after a snapshot, migrations from nothing. When nothing in it is worth keeping."),
        )}
      </ol>
      {failedMigration && (
        <p className="text-muted-foreground">
          {t("If that migration is no longer in the repository, delete its row yourself, then deploy again:")}
          <code className="ml-1 select-all break-all">{`DELETE FROM "_prisma_migrations" WHERE migration_name = '${failedMigration}';`}</code>
        </p>
      )}

      <AlertDialog open={confirmApplied} onOpenChange={setConfirmApplied}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Mark {name} as applied?", { name: failedMigration })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("Its SQL is not run — it is recorded as done and the later migrations go on. Only right when the database already has everything this migration would create, such as after the migrations were squashed. On an incomplete database the service fails later on a missing table.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => onDeploy({ resolveMigration: failedMigration!, resolveAs: "applied" })}>{t("Mark as applied and deploy")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmDataLoss} onOpenChange={setConfirmDataLoss}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Push the schema and lose data?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("prisma db push runs with --accept-data-loss: whatever the warnings in the log name — columns, tables, duplicate rows under a new unique — is deleted. A snapshot is taken first and can be restored from the deployment history.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => onDeploy({ acceptDataLoss: true })}
            >
              {t("Accept and deploy")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmReset} onOpenChange={(open) => { setConfirmReset(open); setTyped(""); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Empty every database of {name}?", { name: application.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("Every table and row is dropped, then the deploy runs the migrations from nothing. A snapshot is taken first and can be restored from the deployment history.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <p className="text-sm">{t("Type {name} to confirm", { name: application.name })}</p>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus className="font-mono" />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={typed !== application.name}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => onDeploy({ resetDatabase: true })}
            >
              {t("Reset and deploy")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * An app that has never deployed: what it still needs, then Deploy. The first
 * deploy is where a missing DATABASE_URL or secret would fail, so it waits
 * for the environment — which is edited in its own tab.
 */
export function AppSetupCard({ application, detected, detecting, env, dbCheck, failure, failedMigration, starting, onDeploy, onEditHosts, onEditEnv, onEditBuild, compact, onShowLog }: AppSetupCardProps) {
  const fixes = <DeployFailureFixes application={application} failure={failure} failedMigration={failedMigration} starting={starting} onDeploy={onDeploy} />;
  // Where it answers comes first: without a host there is nothing to reach, and
  // the env's own addresses (APP_URL, CORS_ORIGIN, VITE_API_URL) are these hosts
  const hosts = hostsOf(application).filter((host) => !host.endsWith(".local"));
  const hostsDone = hosts.length > 0;
  const hostLine = hostsDone ? hosts.join(", ") : t("None yet — add one; the env's addresses are these.");
  const dbFailed = !!dbCheck && dbCheck !== "pending" && !dbCheck.ok;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // the repo uses Prisma and nothing runs its migrations yet: offer the step,
  // one click to set it — the tables have to exist before the app starts
  const suggestedPreDeploy = !application.preDeployCommand ? detected?.preDeployCommand ?? null : null;
  const savePreDeploy = useMutation({
    mutationFn: (command: string) => updateApplication(application.id, { preDeployCommand: command }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["application", application.id] });
      toast({ title: t("Pre-deploy command set") });
    },
    onError: (error: Error) => toast({ variant: "destructive", title: t("Could not save"), description: error.message }),
  });
  const install = application.installCommand || detected?.installCommand;
  const build = application.buildCommand || detected?.buildCommand;
  const start = application.startCommand || detected?.startCommand;
  // Never saved: nobody has looked at it — an env with nothing expected is not
  // "done" by itself. Unsaved edits count as looking: Deploy saves them first.
  const unconfirmed = application.envConfirmed === false && !env.dirty;
  const envDone = !detecting && env.missing.length === 0 && !unconfirmed;
  // a compose stack: which of its services takes the host's traffic — none picked, no route, the hosts do not open
  const isCompose = application.type === "COMPOSE";
  const webDone = !isCompose || !!(application.composeService && application.composePort);
  const webLine = webDone
    ? t("{service} on port {port}", { service: application.composeService ?? "", port: String(application.composePort ?? "") })
    : t("None yet — pick the service that serves the site (the one with a port).");
  const [pickOpen, setPickOpen] = useState(false);
  const pickWeb = useMutation({
    mutationFn: ({ service, port }: { service: string; port: string }) =>
      updateApplication(application.id, { composeService: service, ...(port && { composePort: Number(port) }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["application", application.id] });
      setPickOpen(false);
    },
    onError: (error: Error) => toast({ variant: "destructive", title: t("Could not save"), description: error.message }),
  });
  const picker = (
    <ComposePreview applicationId={application.id} selected={application.composeService ?? ""} onPick={(service, port) => pickWeb.mutate({ service, port })} />
  );
  const ready = hostsDone && envDone && webDone;
  const envLine = detecting
    ? t("Reading the repository…")
    : env.missing.length > 0
      ? t("{count} still empty: {keys}", { count: env.missing.length, keys: env.missing.join(", ") })
      : unconfirmed
        ? t("Not confirmed yet — check it, then save.")
        : env.dirty
          ? t("Unsaved changes — saved when you deploy.")
          : t("Every expected variable has a value.");
  // about the repo's start script — an app with its own start command has taken that over
  const buildWarnings = application.startCommand ? [] : detected?.warnings ?? [];

  if (compact) {
    const Mark = ({ done, warn }: { done: boolean; warn?: boolean }) =>
      done && warn ? (
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
      ) : done ? (
        <CheckCircle className="h-4 w-4 shrink-0 text-green-600" />
      ) : (
        <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />
      );
    const commands = [install, detected?.generateCommand, application.preDeployCommand, build, start].filter(Boolean).join(" → ");
    return (
      <div className="min-w-0 space-y-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 font-medium">
            <Rocket className="h-3.5 w-3.5 text-primary" />
            {t("Set up and deploy")}
          </p>
          <Button type="button" size="sm" className="h-7 bg-gradient-primary px-3 text-xs" onClick={() => onDeploy()} disabled={!ready || starting}>
            {starting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Rocket className="mr-1.5 h-3.5 w-3.5" />}
            {failure ? t("Retry deploy") : t("Deploy")}
          </Button>
        </div>
        <button type="button" onClick={onEditHosts} className="flex w-full min-w-0 items-center gap-2 text-left hover:text-primary">
          <Mark done={hostsDone} />
          <span className="shrink-0 font-medium">{t("Host")}</span>
          <span className={`min-w-0 truncate ${hostsDone ? "font-mono text-muted-foreground" : "text-amber-600 dark:text-amber-400"}`}>{hostLine}</span>
        </button>
        {isCompose && (
          <>
            <button type="button" onClick={() => setPickOpen(!pickOpen)} className="flex w-full min-w-0 items-center gap-2 text-left hover:text-primary">
              <Mark done={webDone} />
              <span className="shrink-0 font-medium">{t("Web service")}</span>
              <span className={`min-w-0 truncate ${webDone ? "font-mono text-muted-foreground" : "text-amber-600 dark:text-amber-400"}`}>{webLine}</span>
            </button>
            {pickOpen && picker}
          </>
        )}
        <button type="button" onClick={onEditEnv} className="flex w-full min-w-0 items-center gap-2 text-left hover:text-primary">
          <Mark done={envDone} warn={dbFailed || env.warnings.length > 0} />
          <span className="shrink-0 font-medium">{t("Environment")}</span>
          {/* tried from the app's node and refused: the one thing to say — the app would fail the same way */}
          {!detecting && !env.missing.length && dbFailed ? (
            <span className="min-w-0 truncate text-destructive" title={(dbCheck as { message: string }).message}>
              {t("DATABASE_URL does not connect: {reason}", { reason: (dbCheck as { message: string }).message })}
            </span>
          ) : !detecting && !env.missing.length && dbCheck === "pending" ? (
            <span className="flex min-w-0 items-center gap-1.5 truncate text-muted-foreground">
              <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
              {t("Testing DATABASE_URL from the service's server…")}
            </span>
          ) : /* filled but likely wrong on the server: said here too, by count and name */
          !detecting && !env.missing.length && env.warnings.length > 0 ? (
            <span className="min-w-0 truncate text-amber-600 dark:text-amber-400" title={env.warnings.join(", ")}>
              {t("{count} to check: {keys}", { count: env.warnings.length, keys: env.warnings.join(", ") })}
              {unconfirmed && ` · ${t("not confirmed yet")}`}
            </span>
          ) : (
            <span className={`min-w-0 truncate ${env.missing.length ? "text-destructive" : unconfirmed ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
              {envLine}
            </span>
          )}
        </button>
        <button type="button" onClick={onEditBuild} className="flex w-full min-w-0 items-center gap-2 text-left hover:text-primary">
          <Mark done={!!(build || start)} warn={buildWarnings.length > 0 || !!suggestedPreDeploy} />
          <span className="shrink-0 font-medium">{t("Build")}</span>
          <span className="min-w-0 truncate font-mono text-muted-foreground" title={commands}>
            {detected ? `${detected.label} · ` : ""}
            {commands || "—"}
          </span>
        </button>
        {/* what needs a look, one line each — the full story is on the app's page */}
        {(suggestedPreDeploy || buildWarnings.length > 0) && (
          <p className="truncate text-amber-600 dark:text-amber-400">
            {suggestedPreDeploy
              ? `${t("The repo uses Prisma — run its migrations before the release goes live:")} ${suggestedPreDeploy}`
              : t("The start script needs a look — open Build.")}
          </p>
        )}
        {failure && (
          <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded border border-destructive/40 bg-destructive/5 p-2 font-mono text-destructive">{failure}</pre>
        )}
        {failure && onShowLog && (
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onShowLog}>
            <Terminal className="mr-1 h-3 w-3" />
            {t("Full log")}
          </Button>
        )}
        {fixes}
      </div>
    );
  }

  const Step = ({ done, warn, title, children, action }: { done: boolean; warn?: boolean; title: string; children?: React.ReactNode; action?: React.ReactNode }) => (
    <div className="flex items-start justify-between gap-3 py-3">
      <div className="flex min-w-0 items-start gap-3">
        {done && warn ? (
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
        ) : done ? (
          <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
        ) : (
          <Circle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 space-y-1">
          <p className="font-medium">{title}</p>
          {children}
        </div>
      </div>
      {action}
    </div>
  );

  return (
    <Card className="bg-gradient-card border-primary/40 shadow-elegant">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Rocket className="h-5 w-5 text-primary" />
          {t("Set up and deploy")}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{t("Not deployed yet. Put its environment in place, then deploy.")}</p>
      </CardHeader>
      <CardContent>
        <div className="divide-y">
          <Step
            done={hostsDone}
            title={t("Host")}
            action={
              <Button type="button" variant="outline" size="sm" onClick={onEditHosts}>
                <Globe className="h-4 w-4 mr-2" />
                {hostsDone ? t("Manage") : t("Add domain / host")}
              </Button>
            }
          >
            <p className={`text-xs ${hostsDone ? "break-all font-mono text-muted-foreground" : "text-amber-600 dark:text-amber-400"}`}>{hostLine}</p>
          </Step>

          {isCompose && (
            <Step
              done={webDone}
              title={t("Web service")}
              action={
                <Button type="button" variant="outline" size="sm" onClick={() => setPickOpen(!pickOpen)}>
                  <Layers className="h-4 w-4 mr-2" />
                  {webDone ? t("Change") : t("Pick")}
                </Button>
              }
            >
              <p className={`text-xs ${webDone ? "font-mono text-muted-foreground" : "text-amber-600 dark:text-amber-400"}`}>{webLine}</p>
              {(pickOpen || !webDone) && <div className="mt-2">{picker}</div>}
            </Step>
          )}

          <Step
            done={envDone}
            warn={env.warnings.length > 0 || dbFailed}
            title={t("Environment")}
            action={
              <Button type="button" variant="outline" size="sm" onClick={onEditEnv}>
                <KeyRound className="h-4 w-4 mr-2" />
                {t("Fill in")}
              </Button>
            }
          >
            <p className="text-xs">
              {detecting ? (
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t("Reading the repository…")}
                </span>
              ) : (
                <span className={env.missing.length > 0 ? "text-destructive" : unconfirmed ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}>
                  {envLine}
                </span>
              )}
            </p>
            {/* filled, but likely wrong on the server — said, not blocking: localhost can be deliberate */}
            {!detecting && env.warnings.length > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {t("{count} to check: {keys}", { count: env.warnings.length, keys: env.warnings.join(", ") })}
              </p>
            )}
            {/* tried for real from the app's node — the app would fail the same way */}
            {dbCheck === "pending" ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t("Testing DATABASE_URL from the service's server…")}
              </p>
            ) : dbFailed ? (
              <p className="flex items-start gap-1 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="break-all">
                  {t("DATABASE_URL does not connect: {reason}", { reason: (dbCheck as { message: string }).message })}
                </span>
              </p>
            ) : dbCheck ? (
              <p className="text-xs text-green-600 dark:text-green-400">{t("DATABASE_URL connects from the service's server.")}</p>
            ) : null}
          </Step>

          <Step
            done={!!(build || start)}
            warn={buildWarnings.length > 0 || !!suggestedPreDeploy}
            title={t("Build")}
            action={
              <Button type="button" variant="ghost" size="sm" onClick={onEditBuild}>
                <Settings className="h-4 w-4 mr-2" />
                {t("Edit")}
              </Button>
            }
          >
            <div className="space-y-0.5 font-mono text-xs text-muted-foreground">
              {detected && <p className="font-sans">{t("Detected: {label}", { label: detected.label })}</p>}
              {[install, detected?.generateCommand, application.preDeployCommand, build, start].filter(Boolean).map((command) => (
                <p key={command} className="truncate">
                  <Terminal className="mr-1 inline h-3 w-3" />
                  {command}
                </p>
              ))}
            </div>
            {suggestedPreDeploy && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
                <Database className="h-3 w-3 shrink-0" />
                <span>
                  {t("The repo uses Prisma — run its migrations before the release goes live:")}{" "}
                  <code className="font-mono">{suggestedPreDeploy}</code>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  disabled={savePreDeploy.isPending}
                  onClick={() => savePreDeploy.mutate(suggestedPreDeploy)}
                >
                  {savePreDeploy.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                  {t("Use it")}
                </Button>
              </div>
            )}
            {buildWarnings.map((warning) => (
              <p key={warning.code} className="flex items-start gap-1 text-xs text-amber-600 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                {warning.code === "start-fixed-port"
                  ? t("The start script pins port {port}; the service must listen on $PORT. Remove -p, or set a start command.", { port: warning.port })
                  : t("The start script runs next start without -H 127.0.0.1, so it also listens on the node's public address.")}
              </p>
            ))}
          </Step>
        </div>

        {/* the last try's reason, right above the button that retries it */}
        {failure && (
          <div className="mt-2 space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-sm font-medium text-destructive">{t("The last deploy failed")}</p>
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs text-destructive">{failure}</pre>
            {fixes}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-4 mt-4">
          {!hostsDone ? (
            <span className="text-xs text-muted-foreground">{t("Add a host to deploy.")}</span>
          ) : !webDone ? (
            <span className="text-xs text-muted-foreground">{t("Pick the web service to deploy.")}</span>
          ) : !envDone && !detecting ? (
            <span className="text-xs text-muted-foreground">
              {env.missing.length > 0 ? t("Fill in the empty variables to deploy.") : t("Confirm the environment to deploy.")}
            </span>
          ) : dbFailed ? (
            // said, not blocking: the database may come up by the time the app starts
            <span className="text-xs text-destructive">{t("The service will not reach its database with this DATABASE_URL.")}</span>
          ) : null}
          <Button
            type="button"
            onClick={() => onDeploy()}
            // only once every expected variable has a value — an empty DATABASE_URL just fails
            disabled={!ready || starting}
            className="bg-gradient-primary"
          >
            {starting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Rocket className="h-4 w-4 mr-2" />}
            {failure ? t("Retry deploy") : t("Deploy")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
