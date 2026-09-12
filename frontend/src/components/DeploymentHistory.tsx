import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Zap, Clock, CheckCircle, XCircle, AlertCircle, Loader2 } from "lucide-react";
import { Application, getLiveBuildLog } from "@/lib/applications";
import { useDeploymentHistory } from "@/hooks/useDeployments";
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

interface DeploymentHistoryProps {
  application: Application;
}

export default function DeploymentHistory({ application }: DeploymentHistoryProps) {
  const { data: deploymentData, isLoading, error } = useDeploymentHistory(application.id);
  
  const deployments = deploymentData?.data || [];
  // numbered from the oldest, across pages
  const { total = deployments.length, page = 1, limit = deployments.length } = deploymentData?.pagination ?? {};

  const getDeploymentIcon = (status: string) => {
    switch (status) {
      case 'SUCCESS':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'FAILED':
        return <XCircle className="h-4 w-4 text-red-500" />;
      case 'BUILDING':
      case 'DEPLOYING':
        return <Loader2 className="h-4 w-4 text-yellow-500 animate-spin" />;
      default:
        return <AlertCircle className="h-4 w-4 text-gray-500" />;
    }
  };

  const getDeploymentBadgeVariant = (status: string) => {
    switch (status) {
      case 'SUCCESS':
        return 'default' as const;
      case 'FAILED':
        return 'destructive' as const;
      case 'BUILDING':
      case 'DEPLOYING':
        return 'secondary' as const;
      default:
        return 'outline' as const;
    }
  };

  const formatDuration = (startTime: string, endTime?: string) => {
    const start = new Date(startTime);
    const end = endTime ? new Date(endTime) : new Date();
    const duration = end.getTime() - start.getTime();
    const minutes = Math.floor(duration / 60000);
    const seconds = Math.floor((duration % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
  };

  return (
    <Card className="bg-gradient-card border-border/50">
      <CardHeader>
        <CardTitle className="flex items-center space-x-2">
          <Zap className="h-5 w-5 text-primary" />
          <span>{t("Deployment History")}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-center text-muted-foreground py-8">
            <Loader2 className="h-8 w-8 mx-auto mb-2 animate-spin" />
            <p>{t("Loading deployment history...")}</p>
          </div>
        ) : error ? (
          <div className="text-center text-muted-foreground py-8">
            <AlertCircle className="h-8 w-8 mx-auto mb-2 text-red-500" />
            <p>{t("Error loading deployment history")}</p>
            <p className="text-sm mt-1">{error.message}</p>
          </div>
        ) : deployments.length > 0 ? (
          // one line per deployment; the logs open on demand
          <div className="divide-y rounded-md border">
            {deployments.map((deployment, index) => {
              const done = !IN_PROGRESS.includes(deployment.status);
              // the first line says what happened: the upload summary, the route error
              const summary = deployment.deployLogs?.trim().split("\n")[0];
              const hasLogs = !!(deployment.deployLogs || deployment.buildLogs);
              return (
                <details key={deployment.id} className="group">
                  <summary
                    className={`flex list-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm hover:bg-muted/50 ${
                      hasLogs ? "cursor-pointer" : ""
                    }`}
                  >
                    {getDeploymentIcon(deployment.status)}
                    <Badge variant={getDeploymentBadgeVariant(deployment.status)} className="text-xs">
                      {deploymentStatusLabel(deployment.status)}
                    </Badge>
                    <span className="text-muted-foreground">#{total - (page - 1) * limit - index}</span>
                    <span
                      className={`min-w-0 flex-1 truncate text-xs ${
                        deployment.status === "FAILED" ? "text-destructive" : "text-muted-foreground"
                      }`}
                      title={summary}
                    >
                      {summary}
                    </span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {new Date(deployment.createdAt).toLocaleString(locale)}
                      {" · "}
                      {done ? formatDuration(deployment.createdAt, deployment.updatedAt) : t("In progress...")}
                    </span>
                  </summary>

                  <div className="space-y-3 px-3 pb-3">
                    {/* the one running prints its build log in the page's status banner */}
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
                  </div>
                </details>
              );
            })}
          </div>
        ) : (
          <div className="text-center text-muted-foreground py-8">
            <Zap className="h-8 w-8 mx-auto mb-2" />
            <p>{t("No deployments yet")}</p>
            <p className="text-sm mt-1">{t("Deploy your application to see deployment history")}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
} 