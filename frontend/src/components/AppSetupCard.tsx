import { AlertTriangle, CheckCircle, Circle, KeyRound, Loader2, Rocket, Settings, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { EnvStatus } from "@/components/AppEnvironment";
import { Application, DetectedProject } from "@/lib/applications";
import { t } from "@/lib/i18n";

interface AppSetupCardProps {
  application: Application;
  detected?: DetectedProject | null;
  detecting: boolean;
  /** the Environment tab's form as it stands */
  env: EnvStatus;
  /** the saved DATABASE_URL tried from the app's node: running, its outcome, or not tried */
  dbCheck?: "pending" | { ok: boolean; message: string } | null;
  onDeploy: () => void;
  onEditEnv: () => void;
  onEditBuild: () => void;
}

/**
 * An app that has never deployed: what it still needs, then Deploy. The first
 * deploy is where a missing DATABASE_URL or secret would fail, so it waits
 * for the environment — which is edited in its own tab.
 */
export function AppSetupCard({ application, detected, detecting, env, dbCheck, onDeploy, onEditEnv, onEditBuild }: AppSetupCardProps) {
  const dbFailed = !!dbCheck && dbCheck !== "pending" && !dbCheck.ok;
  const install = application.installCommand || detected?.installCommand;
  const build = application.buildCommand || detected?.buildCommand;
  const start = application.startCommand || detected?.startCommand;
  const envDone = !detecting && env.missing.length === 0 && !env.dirty;
  // about the repo's start script — an app with its own start command has taken that over
  const buildWarnings = application.startCommand ? [] : detected?.warnings ?? [];

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
              ) : env.missing.length > 0 ? (
                <span className="text-destructive">
                  {t("{count} still empty: {keys}", { count: env.missing.length, keys: env.missing.join(", ") })}
                </span>
              ) : env.dirty ? (
                <span className="text-amber-600 dark:text-amber-400">{t("Unsaved changes — save the environment first.")}</span>
              ) : (
                <span className="text-muted-foreground">{t("Every expected variable has a value.")}</span>
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
            warn={buildWarnings.length > 0}
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
              {[install, build, application.preDeployCommand, start].filter(Boolean).map((command) => (
                <p key={command} className="truncate">
                  <Terminal className="mr-1 inline h-3 w-3" />
                  {command}
                </p>
              ))}
            </div>
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

        <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-4">
          {!envDone && !detecting ? (
            <span className="text-xs text-muted-foreground">
              {env.dirty ? t("Save the environment before deploying.") : t("Fill in the empty variables to deploy.")}
            </span>
          ) : dbFailed ? (
            // said, not blocking: the database may come up by the time the app starts
            <span className="text-xs text-destructive">{t("The app will not reach its database with this DATABASE_URL.")}</span>
          ) : null}
          <Button
            type="button"
            onClick={onDeploy}
            // only once every expected variable is filled in and saved — a deploy
            // uses the saved environment, and an empty DATABASE_URL just fails
            disabled={!envDone}
            className="bg-gradient-primary"
          >
            <Rocket className="h-4 w-4 mr-2" />
            {t("Deploy")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
