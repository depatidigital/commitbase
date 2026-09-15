import { CheckCircle, Loader2 } from "lucide-react";
import { LiveBuildLog } from "@/components/DeploymentHistory";
import { t } from "@/lib/i18n";

const DEPLOY_PHASES = [
  { status: "PENDING", label: t("Queued") },
  { status: "BUILDING", label: t("Building") },
  { status: "DEPLOYING", label: t("Going live") },
];

/**
 * A deploy in progress: where it is (queued → building → going live) and its
 * build log as it prints. The app page's status banner and the project page's
 * app cards show the same one.
 */
export function DeployProgress({
  appId,
  status,
  redeploy,
  published,
  logText,
  showLog = true,
}: {
  appId: string;
  /** the running deployment's status */
  status?: string;
  /** it has a release already — "Redeploying" */
  redeploy: boolean;
  /** something is served now: said that it keeps serving until the new one answers */
  published: boolean;
  /** an imported app's build writes onto its deployment row, not a log on disk — that text */
  logText?: string;
  /** an uploaded site builds nothing: no log */
  showLog?: boolean;
}) {
  const phaseIndex = Math.max(0, DEPLOY_PHASES.findIndex((phase) => phase.status === status));
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          {redeploy ? t("Redeploying…") : t("Deploying…")}
        </h3>
        <ol className="flex flex-wrap items-center gap-2 text-sm">
          {DEPLOY_PHASES.map((phase, index) => (
            <li
              key={phase.status}
              className={`flex items-center gap-1.5 ${
                index < phaseIndex ? "text-primary" : index === phaseIndex ? "font-medium" : "text-muted-foreground/60"
              }`}
            >
              {index < phaseIndex ? (
                <CheckCircle className="h-4 w-4" />
              ) : index === phaseIndex ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <span className="h-4 w-4 rounded-full border" />
              )}
              {phase.label}
              {index < DEPLOY_PHASES.length - 1 && <span className="text-muted-foreground/50">→</span>}
            </li>
          ))}
        </ol>
      </div>
      {published && <p className="mt-1 text-xs text-muted-foreground">{t("The current release keeps serving until the new one answers.")}</p>}
      {/* queued: build.log is still the previous deploy's — not shown as if it were this one's */}
      {showLog && status === "PENDING" ? (
        <p className="mt-3 text-sm text-muted-foreground">{t("Waiting for its turn — the log appears once the build starts.")}</p>
      ) : (
        showLog && <LiveBuildLog appId={appId} text={logText} />
      )}
    </div>
  );
}
