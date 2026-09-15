import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle, Circle, Database, KeyRound, Loader2, Rocket, Settings, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { EnvStatus } from "@/components/AppEnvironment";
import { useToast } from "@/hooks/use-toast";
import { Application, DetectedProject, updateApplication } from "@/lib/applications";
import { t } from "@/lib/i18n";

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
  /** Deploy was clicked and is saving or starting */
  starting?: boolean;
  onDeploy: () => void;
  onEditEnv: () => void;
  onEditBuild: () => void;
  /** one line a step, in a small box — the project page's app cards */
  compact?: boolean;
}

/**
 * An app that has never deployed: what it still needs, then Deploy. The first
 * deploy is where a missing DATABASE_URL or secret would fail, so it waits
 * for the environment — which is edited in its own tab.
 */
export function AppSetupCard({ application, detected, detecting, env, dbCheck, failure, starting, onDeploy, onEditEnv, onEditBuild, compact }: AppSetupCardProps) {
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
          <Button type="button" size="sm" className="h-7 bg-gradient-primary px-3 text-xs" onClick={onDeploy} disabled={!envDone || starting}>
            {starting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Rocket className="mr-1.5 h-3.5 w-3.5" />}
            {failure ? t("Retry deploy") : t("Deploy")}
          </Button>
        </div>
        <button type="button" onClick={onEditEnv} className="flex w-full min-w-0 items-center gap-2 text-left hover:text-primary">
          <Mark done={envDone} warn={dbFailed} />
          <span className="shrink-0 font-medium">{t("Environment")}</span>
          <span className={`min-w-0 truncate ${env.missing.length ? "text-destructive" : unconfirmed ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
            {envLine}
          </span>
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
        {(dbFailed || suggestedPreDeploy || buildWarnings.length > 0) && (
          <p className="truncate text-amber-600 dark:text-amber-400">
            {dbFailed
              ? t("DATABASE_URL does not connect: {reason}", { reason: (dbCheck as { message: string }).message })
              : suggestedPreDeploy
                ? `${t("The repo uses Prisma — run its migrations before the release goes live:")} ${suggestedPreDeploy}`
                : t("The start script needs a look — see Build on the app's page.")}
          </p>
        )}
        {failure && (
          <pre className="max-h-16 overflow-auto whitespace-pre-wrap rounded border border-destructive/40 bg-destructive/5 p-1.5 font-mono text-destructive">{failure}</pre>
        )}
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
                {t("Testing DATABASE_URL from the app's server…")}
              </p>
            ) : dbFailed ? (
              <p className="flex items-start gap-1 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="break-all">
                  {t("DATABASE_URL does not connect: {reason}", { reason: (dbCheck as { message: string }).message })}
                </span>
              </p>
            ) : dbCheck ? (
              <p className="text-xs text-green-600 dark:text-green-400">{t("DATABASE_URL connects from the app's server.")}</p>
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
                  ? t("The start script pins port {port}; the app must listen on $PORT. Remove -p, or set a start command.", { port: warning.port })
                  : t("The start script runs next start without -H 127.0.0.1, so it also listens on the node's public address.")}
              </p>
            ))}
          </Step>
        </div>

        {/* the last try's reason, right above the button that retries it */}
        {failure && (
          <div className="mt-2 space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-sm font-medium text-destructive">{t("The last deploy failed")}</p>
            <pre className="max-h-24 overflow-auto whitespace-pre-wrap font-mono text-xs text-destructive">{failure}</pre>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-4 mt-4">
          {!envDone && !detecting ? (
            <span className="text-xs text-muted-foreground">
              {env.missing.length > 0 ? t("Fill in the empty variables to deploy.") : t("Confirm the environment to deploy.")}
            </span>
          ) : dbFailed ? (
            // said, not blocking: the database may come up by the time the app starts
            <span className="text-xs text-destructive">{t("The app will not reach its database with this DATABASE_URL.")}</span>
          ) : null}
          <Button
            type="button"
            onClick={onDeploy}
            // only once every expected variable has a value — an empty DATABASE_URL just fails
            disabled={!envDone || starting}
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
