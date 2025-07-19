import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Zap, Clock, CheckCircle, XCircle, AlertCircle, Loader2 } from "lucide-react";
import { Application } from "@/lib/applications";
import { useDeploymentHistory } from "@/hooks/useDeployments";

interface DeploymentHistoryProps {
  application: Application;
}

export default function DeploymentHistory({ application }: DeploymentHistoryProps) {
  const { data: deploymentData, isLoading, error } = useDeploymentHistory(application.id);
  
  const deployments = deploymentData?.data || [];
  const pagination = deploymentData?.pagination;

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
          <span>Deployment History</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-center text-muted-foreground py-8">
            <Loader2 className="h-8 w-8 mx-auto mb-2 animate-spin" />
            <p>Loading deployment history...</p>
          </div>
        ) : error ? (
          <div className="text-center text-muted-foreground py-8">
            <AlertCircle className="h-8 w-8 mx-auto mb-2 text-red-500" />
            <p>Error loading deployment history</p>
            <p className="text-sm mt-1">{error.message}</p>
          </div>
        ) : deployments.length > 0 ? (
          <div className="space-y-4">
            {deployments.map((deployment, index) => (
              <div key={deployment.id} className="border rounded-lg p-4 hover:bg-muted/50 transition-colors">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center space-x-3">
                    {getDeploymentIcon(deployment.status)}
                    <Badge variant={getDeploymentBadgeVariant(deployment.status)}>
                      {deployment.status}
                    </Badge>
                    <span className="text-sm text-muted-foreground">
                      #{deployments.length - index}
                    </span>
                  </div>
                  <div className="flex items-center space-x-2 text-sm text-muted-foreground">
                    <Clock className="h-4 w-4" />
                    <span>{new Date(deployment.createdAt).toLocaleString()}</span>
                  </div>
                </div>

                {/* Deployment Details */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                  <div>
                    <span className="font-medium">Status:</span>
                    <p className="text-muted-foreground">
                      {deployment.status}
                    </p>
                  </div>
                  <div>
                    <span className="font-medium">Duration:</span>
                    <p className="text-muted-foreground">
                      {deployment.status === 'SUCCESS' || deployment.status === 'FAILED'
                        ? formatDuration(deployment.createdAt, deployment.updatedAt)
                        : 'In progress...'
                      }
                    </p>
                  </div>
                  <div>
                    <span className="font-medium">Created:</span>
                    <p className="text-muted-foreground">
                      {new Date(deployment.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>

                {/* Build Logs */}
                {deployment.buildLogs && (
                  <details className="mt-4">
                    <summary className="cursor-pointer text-sm font-medium hover:text-primary transition-colors">
                      Build Logs
                    </summary>
                    <div className="mt-2 p-3 bg-muted rounded-md">
                      <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto">
                        {deployment.buildLogs}
                      </pre>
                    </div>
                  </details>
                )}


              </div>
            ))}
          </div>
        ) : (
          <div className="text-center text-muted-foreground py-8">
            <Zap className="h-8 w-8 mx-auto mb-2" />
            <p>No deployments yet</p>
            <p className="text-sm mt-1">Deploy your application to see deployment history</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
} 