import { useNavigate } from "react-router-dom";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle,
  ExternalLink,
  Loader2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  useApplication,
  useApplicationHostname,
  useSetupApplicationDns,
} from "@/hooks/useApplications";
import type { DnsOutcome } from "@/lib/applications";

type StepState = "pending" | "running" | "done" | "failed";

const Step = ({
  state,
  title,
  detail,
  action,
}: {
  state: StepState;
  title: string;
  detail?: string;
  action?: React.ReactNode;
}) => (
  <div className="flex items-start gap-3 border-b border-border/60 py-3 last:border-0">
    <span className="mt-0.5">
      {state === "done" ? (
        <CheckCircle className="h-4 w-4 text-success" />
      ) : state === "failed" ? (
        <AlertCircle className="h-4 w-4 text-destructive" />
      ) : state === "running" ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <span className="block h-4 w-4 rounded-full border border-border" />
      )}
    </span>
    <div className="min-w-0 flex-1">
      <div className="text-sm font-medium">{title}</div>
      {detail && (
        <div className="text-xs text-muted-foreground">{detail}</div>
      )}
    </div>
    {action}
  </div>
);

/**
 * What happens after "Deploy": the app row, its DNS record, the build, and
 * finally the hostname answering over HTTPS. The wizard used to drop the user
 * on the dashboard here, where none of this was visible.
 */
export const AppLaunchProgress = ({
  applicationId,
  domain,
  dns,
  uploading,
  uploadFailed,
}: {
  applicationId: string;
  domain: string;
  dns?: DnsOutcome;
  /** true while the picked folder is still being sent */
  uploading: boolean;
  uploadFailed?: string | null;
}) => {
  const navigate = useNavigate();
  const { data: application } = useApplication(applicationId);
  const setupDns = useSetupApplicationDns();

  // the build has to finish before the hostname can answer, so only poll then
  const deployed =
    application?.status === "RUNNING" || application?.status === "ERROR";
  const { data: health } = useApplicationHostname(applicationId, deployed);

  const dnsFailed = dns?.state === "conflict" || dns?.state === "unavailable";
  const status = application?.status;

  const deployState: StepState = uploading
    ? "pending"
    : status === "DEPLOYING" || status === "BUILDING"
      ? "running"
      : status === "RUNNING"
        ? "done"
        : status === "ERROR"
          ? "failed"
          : "pending";

  const liveState: StepState =
    deployState !== "done"
      ? "pending"
      : health?.live
        ? "done"
        : "running";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Setting up {domain}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <Step state="done" title="Application created" />

        <Step
          state={dnsFailed ? "failed" : "done"}
          title="DNS"
          detail={dns?.detail ?? "Hostname pointed at the platform"}
          action={
            dnsFailed && dns?.state === "conflict" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={setupDns.isPending}
                onClick={() =>
                  setupDns.mutate({ id: applicationId, force: true })
                }
              >
                Repoint it here
              </Button>
            ) : undefined
          }
        />

        <Step
          state={uploadFailed ? "failed" : uploading ? "running" : "done"}
          title="Source files"
          detail={uploadFailed ?? undefined}
        />

        <Step
          state={deployState}
          title="Build and deploy"
          detail={
            deployState === "failed"
              ? "The deployment failed — open the app to read its build log"
              : deployState === "running"
                ? "Building on the server"
                : undefined
          }
        />

        <Step
          state={liveState}
          title="Live over HTTPS"
          detail={
            liveState === "done"
              ? `Answering with HTTP ${health?.httpStatus}`
              : liveState === "running"
                ? (health?.error ??
                  "Waiting for DNS to propagate and the certificate to be issued")
                : undefined
          }
        />

        <div className="flex items-center justify-between gap-3 pt-4">
          <Button variant="outline" onClick={() => navigate("/")}>
            Back to dashboard
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => navigate(`/application/${applicationId}`)}
            >
              Open app
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
            <Button
              disabled={!health?.live}
              onClick={() => window.open(`https://${domain}`, "_blank")}
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              Visit site
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default AppLaunchProgress;
