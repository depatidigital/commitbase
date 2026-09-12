import { CheckCircle, Circle, Loader2, Rocket, Settings, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AppEnvironment, missingKeys } from "@/components/AppEnvironment";
import { Application, DetectedProject } from "@/lib/applications";
import { t } from "@/lib/i18n";

interface AppSetupCardProps {
  application: Application;
  detected?: DetectedProject | null;
  detecting: boolean;
  onDeploy: () => void;
  onEditBuild: () => void;
}

/**
 * An app that has never deployed: what it still needs, in order, then Deploy.
 * The first deploy is where a missing DATABASE_URL or secret would fail, so it
 * happens here once the environment is in place — not on creation.
 */
export function AppSetupCard({ application, detected, detecting, onDeploy, onEditBuild }: AppSetupCardProps) {
  const missing = missingKeys(application, detected);
  const install = application.installCommand || detected?.installCommand;
  const build = application.buildCommand || detected?.buildCommand;
  const start = application.startCommand || detected?.startCommand;

  const Step = ({ done, children }: { done: boolean; children: React.ReactNode }) => (
    <span className="flex items-center gap-2 font-medium">
      {done ? <CheckCircle className="h-4 w-4 text-green-600" /> : <Circle className="h-4 w-4 text-muted-foreground" />}
      {children}
    </span>
  );

  return (
    <Card className="bg-gradient-card border-primary/40 shadow-elegant">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Rocket className="h-5 w-5 text-primary" />
          {t("Set up and deploy")}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {t("Not deployed yet. Put its environment in place, then deploy.")}
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-3">
          <Step done={missing.length === 0 && !detecting}>
            {t("Environment")}
            {detecting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            ) : missing.length > 0 ? (
              <span className="text-xs font-normal text-destructive">
                {t("{count} still empty: {keys}", { count: missing.length, keys: missing.join(", ") })}
              </span>
            ) : null}
          </Step>
          <AppEnvironment application={application} detected={detected} />
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Step done={!!(build || start)}>{t("Build")}</Step>
            <Button type="button" variant="ghost" size="sm" onClick={onEditBuild}>
              <Settings className="h-4 w-4 mr-2" />
              {t("Edit")}
            </Button>
          </div>
          <div className="rounded-md bg-muted/40 p-3 font-mono text-xs space-y-1">
            {detected && <p className="font-sans text-muted-foreground">{t("Detected: {label}", { label: detected.label })}</p>}
            {install && <p><Terminal className="mr-1 inline h-3 w-3" />{install}</p>}
            {build && <p><Terminal className="mr-1 inline h-3 w-3" />{build}</p>}
            {application.preDeployCommand && <p><Terminal className="mr-1 inline h-3 w-3" />{application.preDeployCommand}</p>}
            {start && <p><Terminal className="mr-1 inline h-3 w-3" />{start}</p>}
          </div>
        </section>

        <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-4">
          {missing.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {t("Deploying with empty variables will most likely fail.")}
            </span>
          )}
          <Button type="button" onClick={onDeploy} variant={missing.length > 0 ? "outline" : "default"} className={missing.length > 0 ? "" : "bg-gradient-primary"}>
            <Rocket className="h-4 w-4 mr-2" />
            {t("Deploy")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
