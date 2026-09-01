import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { OrganizationFilter } from "@/components/OrganizationFilter";
import {
  Server,
  Plus,
  Activity,
  AlertCircle,
  Zap,
  Globe,
  HardDrive,
  Cpu,
  Play,
  Square,
  RotateCcw,
  Trash2,
  Search,
  Loader2,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import {
  useApplicationsWithRealtime,
  useStartApplication,
  useStartExistingApplication,
  useStopApplication,
  useRestartApplication,
  useDeleteApplication,
} from "@/hooks/useApplications";
import { hasBeenDeployed } from "@/lib/applications";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export default function Application() {
  const query = useTableQuery();
  const [confirmAction, setConfirmAction] = useState<{
    type: "start" | "start-existing" | "stop" | "restart" | "delete";
    appId: string;
    appName: string;
  } | null>(null);
  const { toast } = useToast();

  // API hooks
  const {
    data: applicationsData,
    isLoading,
    error,
  } = useApplicationsWithRealtime(query.page, query.limit, query.search);
  const startApp = useStartApplication();
  const startExistingApp = useStartExistingApplication();
  const stopApp = useStopApplication();
  const restartApp = useRestartApplication();
  const deleteApp = useDeleteApplication();

  const applications = applicationsData?.data || [];

  const handleStart = async (id: string, name: string) => {
    setConfirmAction({ type: "start", appId: id, appName: name });
  };

  const handleStartExisting = async (id: string, name: string) => {
    setConfirmAction({ type: "start-existing", appId: id, appName: name });
  };

  const handleStop = async (id: string, name: string) => {
    setConfirmAction({ type: "stop", appId: id, appName: name });
  };

  const handleRestart = async (id: string, name: string) => {
    setConfirmAction({ type: "restart", appId: id, appName: name });
  };

  const handleDelete = async (id: string, name: string) => {
    setConfirmAction({ type: "delete", appId: id, appName: name });
  };

  const executeAction = async () => {
    if (!confirmAction) return;

    try {
      switch (confirmAction.type) {
        case "start":
          await startApp.mutateAsync(confirmAction.appId);
          break;
        case "start-existing":
          await startExistingApp.mutateAsync(confirmAction.appId);
          break;
        case "stop":
          await stopApp.mutateAsync(confirmAction.appId);
          break;
        case "restart":
          await restartApp.mutateAsync(confirmAction.appId);
          break;
        case "delete":
          await deleteApp.mutateAsync(confirmAction.appId);
          break;
      }
    } catch (error) {
      // Error is handled by the mutation
    } finally {
      setConfirmAction(null);
    }
  };

  const getDialogContent = () => {
    if (!confirmAction) return null;

    const { type, appName } = confirmAction;

    // Find the application to check if it has been deployed
    const app = applications.find((a) => a.id === confirmAction.appId);

    switch (type) {
      case "start":
        return {
          title: hasBeenDeployed(app!)
            ? "Redeploy & Start Application"
            : "Deploy & Start Application",
          description: hasBeenDeployed(app!)
            ? `Are you sure you want to redeploy and start "${appName}"? This will rebuild and run the application.`
            : `Are you sure you want to deploy and start "${appName}"? This will build and run the application for the first time.`,
          actionText: hasBeenDeployed(app!)
            ? "Redeploy & Start"
            : "Deploy & Start",
          variant: "default" as const,
        };
      case "start-existing":
        return {
          title: "Start Application",
          description: `Are you sure you want to start "${appName}"? This will start the existing built application without rebuilding.`,
          actionText: "Start Application",
          variant: "default" as const,
        };
      case "stop":
        return {
          title: "Stop Application",
          description: `Are you sure you want to stop "${appName}"? This will shut down the running application.`,
          actionText: "Stop Application",
          variant: "destructive" as const,
        };
      case "restart":
        return {
          title: "Restart Application",
          description: `Are you sure you want to restart "${appName}"? This will stop and then start the application.`,
          actionText: "Restart Application",
          variant: "default" as const,
        };
      case "delete":
        return {
          title: "Delete Application",
          description: `Are you sure you want to delete "${appName}"? This action cannot be undone and will permanently remove the application and all its data.`,
          actionText: "Delete Application",
          variant: "destructive" as const,
        };
    }
  };

  const runningApps = applications.filter(
    (app) => app.status === "RUNNING",
  ).length;
  const errorApps = applications.filter((app) => app.status === "ERROR").length;
  const deployingApps = applications.filter(
    (app) => app.status === "DEPLOYING" || app.status === "BUILDING",
  ).length;

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-2">
            Error Loading Applications
          </h3>
          <p className="text-muted-foreground">
            Failed to load applications. Please try again.
          </p>
        </div>
      </div>
    );
  }

  const dialogContent = getDialogContent();

  const columns: Column<(typeof applications)[number]>[] = [
    {
      header: "Name",
      className: "w-[18%]",
      cell: (app) => (
        <Link
          to={`/application/${app.id}`}
          className="block truncate font-medium transition-colors hover:text-primary"
        >
          {app.name}
        </Link>
      ),
    },
    {
      header: "Organization",
      className: "w-[16%]",
      cell: (app) =>
        app.organization ? (
          <Badge variant="outline" className="max-w-full truncate">
            {app.organization.name}
          </Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      header: "Domain",
      className: "w-[18%]",
      cell: (app) => (
        <div className="flex min-w-0 items-center space-x-2">
          <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm">{app.domain}</span>
        </div>
      ),
    },
    {
      header: "Type",
      className: "w-24",
      cell: (app) => <Badge variant="secondary">{app.type}</Badge>,
    },
    {
      header: "Status",
      className: "w-28",
      cell: (app) => (
        <div className="flex items-center space-x-2">
          {app.status === "DEPLOYING" || app.status === "BUILDING" ? (
            <Loader2 className="h-4 w-4 animate-spin text-yellow-500" />
          ) : (
            <div
              className={`h-2 w-2 rounded-full ${
                app.status === "RUNNING"
                  ? "bg-green-500"
                  : app.status === "STOPPED"
                    ? "bg-gray-500"
                    : app.status === "ERROR"
                      ? "bg-red-500"
                      : "bg-blue-500"
              }`}
            />
          )}
          <span className="capitalize">{app.status.toLowerCase()}</span>
        </div>
      ),
    },
    { header: "Port", className: "w-20", cell: (app) => app.port || "-" },
    {
      header: "Last Deployment",
      className: "w-28 text-xs",
      cell: (app) =>
        app.deployments && app.deployments.length > 0
          ? new Date(app.deployments[0].createdAt).toLocaleDateString()
          : "-",
    },
    {
      header: "Actions",
      className: "w-40",
      cell: (app) => (
        <div className="flex items-center space-x-2">
          {app.status === "RUNNING" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => handleStop(app.id, app.name)}
                  aria-label="Stop application"
                  disabled={stopApp.isPending}
                  className="h-8 w-8 p-0"
                >
                  {stopApp.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Square className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Stop Application</p>
              </TooltipContent>
            </Tooltip>
          ) : hasBeenDeployed(app) ? (
            // Show both Start and Redeploy buttons for previously deployed apps
            <div className="flex items-center space-x-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    onClick={() => handleStartExisting(app.id, app.name)}
                    aria-label="Start existing container"
                    disabled={startExistingApp.isPending}
                    className="h-8 px-2 text-xs"
                  >
                    {startExistingApp.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Play className="h-3 w-3" />
                    )}
                    Start
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Start existing application</p>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleStart(app.id, app.name)}
                    aria-label="Start application"
                    disabled={startApp.isPending}
                    className="h-8 px-2 text-xs"
                  >
                    {startApp.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3 w-3" />
                    )}
                    Redeploy
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Rebuild and start application</p>
                </TooltipContent>
              </Tooltip>
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleStart(app.id, app.name)}
                  aria-label="Start application"
                  disabled={startApp.isPending}
                  className="h-8 w-8 p-0"
                >
                  {startApp.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Deploy & Start</p>
              </TooltipContent>
            </Tooltip>
          )}
          {/* Restart button - only show if application is running */}
          {app.status === "RUNNING" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleRestart(app.id, app.name)}
                  aria-label="Restart application"
                  disabled={restartApp.isPending}
                  className="h-8 w-8 p-0"
                >
                  {restartApp.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RotateCcw className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Restart Application</p>
              </TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleDelete(app.id, app.name)}
                aria-label="Delete application"
                disabled={deleteApp.isPending || app.status === "RUNNING"}
                className="h-8 w-8 p-0 text-destructive hover:text-destructive disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleteApp.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            {app.status === "RUNNING" && (
              <TooltipContent>
                <p>Stop the application first before deleting</p>
              </TooltipContent>
            )}
          </Tooltip>
        </div>
      ),
    },
  ];

  return (
    <TooltipProvider>
      <PageLayout
        title="Applications"
        description="Manage your applications and services."
        actions={
          <Link to="/add-app">
            <Button className="bg-gradient-primary shadow-glow transition-all duration-300 hover:shadow-elegant">
              <Plus className="mr-2 h-4 w-4" />
              Deploy New Application
            </Button>
          </Link>
        }
      >
        <DataTable
          columns={columns}
          rows={applications}
          rowKey={(app) => app.id}
          query={query}
          pagination={applicationsData?.pagination}
          isLoading={isLoading}
          searchPlaceholder="Search name or domain…"
          empty="No applications yet — deploy your first one."
          toolbar={
            <>
              <OrganizationFilter query={query} />
              <div className="flex items-center space-x-2 text-sm text-muted-foreground">
                <Activity className="h-4 w-4 text-success" />
                <span>{runningApps} running</span>
                {deployingApps > 0 && (
                  <>
                    <Loader2 className="ml-4 h-4 w-4 animate-spin text-yellow-500" />
                    <span>{deployingApps} deploying</span>
                  </>
                )}
                {errorApps > 0 && (
                  <>
                    <AlertCircle className="ml-4 h-4 w-4 text-destructive" />
                    <span>{errorApps} errors</span>
                  </>
                )}
              </div>
            </>
          }
        />

        {/* Confirmation Dialog */}
        {confirmAction && dialogContent && (
          <AlertDialog
            open={!!confirmAction}
            onOpenChange={() => setConfirmAction(null)}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{dialogContent.title}</AlertDialogTitle>
                <AlertDialogDescription>
                  {dialogContent.description}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={executeAction}
                  className={
                    dialogContent.variant === "destructive"
                      ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      : undefined
                  }
                  disabled={
                    startApp.isPending ||
                    stopApp.isPending ||
                    restartApp.isPending ||
                    deleteApp.isPending
                  }
                >
                  {startApp.isPending ||
                  stopApp.isPending ||
                  restartApp.isPending ||
                  deleteApp.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Processing...
                    </>
                  ) : (
                    dialogContent.actionText
                  )}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </PageLayout>
    </TooltipProvider>
  );
}
