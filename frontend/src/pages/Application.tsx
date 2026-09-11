import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { OrganizationFilter } from "@/components/OrganizationFilter";
import {
  Server,
  Plus,
  AlertCircle,
  Zap,
  Globe,
  HardDrive,
  Cpu,
  Play,
  Square,
  Upload,
  RotateCcw,
  Trash2,
  Search,
  Loader2,
  RefreshCw,
  Eye,
  ExternalLink,
  MoreHorizontal,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HeartbeatBar, healthLabel } from "@/components/HeartbeatBar";
import { AppTypeBadge } from "@/components/AppTypeBadge";
import { getApplicationHealth } from "@/lib/health";
import { useToast } from "@/hooks/use-toast";
import {
  useApplicationsWithRealtime,
  useStartApplication,
  useStartExistingApplication,
  useStopApplication,
  useRestartApplication,
  useDeleteApplication,
  useSyncServerApps,
} from "@/hooks/useApplications";
import { isSuperAdmin } from "@/lib/auth";
import { bulkAssignApplications, hasBeenDeployed } from "@/lib/applications";
import { OrganizationCombobox } from "@/components/OrganizationCombobox";
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

/** Compact relative time — "3d ago". The exact stamp lives in the title. */
const ago = (value: string) => {
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

export default function Application() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // an inventory screen, not a dashboard: show a useful page of it at once
  const query = useTableQuery(25);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkOrgId, setBulkOrgId] = useState("");
  const [confirmAction, setConfirmAction] = useState<{
    type: "start" | "start-existing" | "stop" | "restart" | "delete";
    appId: string;
    appName: string;
  } | null>(null);
  const { toast } = useToast();
  const syncApps = useSyncServerApps();
  const superAdmin = isSuperAdmin();

  // API hooks
  const {
    data: applicationsData,
    isLoading,
    error,
  } = useApplicationsWithRealtime(query.params);
  const startApp = useStartApplication();
  const startExistingApp = useStartExistingApplication();
  const stopApp = useStopApplication();
  const restartApp = useRestartApplication();
  const deleteApp = useDeleteApplication();

  const applications = applicationsData?.data || [];

  // One request for the whole page's history — a call per row would be 25 round
  // trips for one screen. Refetched on the same rhythm the checks are written.
  const ids = applications.map((app) => app.id);
  const { data: healthById = {} } = useQuery({
    queryKey: ["applications", "health", ids],
    queryFn: () => getApplicationHealth(ids),
    enabled: ids.length > 0,
    refetchInterval: 60_000,
  });

  // one app from its row's modal, or the selection from the bulk bar
  const [assignTarget, setAssignTarget] = useState<{ id: string; name: string } | null>(null);
  const [assignOrgId, setAssignOrgId] = useState<string | null>(null);

  const bulkAssign = useMutation({
    mutationFn: ({ ids, organizationId }: { ids: string[]; organizationId: string | null }) =>
      bulkAssignApplications(ids, organizationId),
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ["applications"] });
      setSelectedIds([]);
      setBulkOrgId("");
      setAssignTarget(null);
      toast({ title: "Assigned", description: `${count} application(s) updated` });
    },
    onError: (error: Error) =>
      toast({ title: "Assign failed", description: error.message, variant: "destructive" }),
  });

  const allSelected =
    applications.length > 0 && applications.every((app) => selectedIds.includes(app.id));

  const toggleAll = () =>
    setSelectedIds(allSelected ? [] : applications.map((app) => app.id));

  const toggleOne = (id: string) =>
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

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
            ? "Redeploy & Start App"
            : "Deploy & Start App",
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
          title: "Start App",
          description: `Are you sure you want to start "${appName}"? This will start the existing built application without rebuilding.`,
          actionText: "Start App",
          variant: "default" as const,
        };
      case "stop":
        return {
          title: "Stop App",
          description: `Are you sure you want to stop "${appName}"? This will shut down the running application.`,
          actionText: "Stop App",
          variant: "destructive" as const,
        };
      case "restart":
        return {
          title: "Restart App",
          description: `Are you sure you want to restart "${appName}"? This will stop and then start the application.`,
          actionText: "Restart App",
          variant: "default" as const,
        };
      case "delete":
        return {
          title: "Delete App",
          description: `Are you sure you want to delete "${appName}"? This action cannot be undone and will permanently remove the application and all its data.`,
          actionText: "Delete App",
          variant: "destructive" as const,
        };
    }
  };

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-2">
            Error Loading Apps
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
    ...(superAdmin
      ? [
          {
            header: (
              <Checkbox
                checked={allSelected}
                onCheckedChange={toggleAll}
                aria-label="Select all applications on this page"
              />
            ),
            className: "w-10",
            cell: (app: (typeof applications)[number]) => (
              <Checkbox
                checked={selectedIds.includes(app.id)}
                onCheckedChange={() => toggleOne(app.id)}
                aria-label={`Select ${app.name}`}
              />
            ),
          },
        ]
      : []),
    {
      header: "Application",
      className: "w-[22%]",
      sortKey: "name",
      // name and hostname are the same string for every imported site, so they
      // share one cell: the name leads, the address and the owner sit under it
      cell: (app) => {
        // an imported site is named after its hostname, so printing both is
        // printing the same string twice — the second line only earns its
        // place when the app was given a name of its own
        const named = app.name.trim().toLowerCase() !== app.domain.trim().toLowerCase();

        return (
          <div className="min-w-0">
            <span className="flex min-w-0 items-center gap-1.5">
              <Link
                to={`/application/${app.id}`}
                className="truncate font-medium transition-colors hover:text-primary"
              >
                {app.name}
              </Link>
              <a
                href={`https://${app.domain}`}
                target="_blank"
                rel="noreferrer"
                title={`Open https://${app.domain}`}
                aria-label={`Open ${app.domain}`}
                className="shrink-0 text-muted-foreground hover:text-primary"
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            </span>
            {named && (
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <Globe className="h-3 w-3 shrink-0" />
                <span className="truncate">{app.domain}</span>
              </span>
            )}
          </div>
        );
      },
    },
    ...(superAdmin
      ? [
          {
            header: "Organization",
            className: "w-[16%]",
            sortKey: "organization",
            // its own column only because a superadmin is the one who assigns
            // it — everyone else sees a single organization's apps anyway
            cell: (app: (typeof applications)[number]) => (
              <button
                type="button"
                title="Change organization"
                className="max-w-full"
                onClick={() => {
                  setAssignOrgId(app.organization?.id ?? null);
                  setAssignTarget({ id: app.id, name: app.name });
                }}
              >
                {app.organization ? (
                  <Badge variant="outline" className="max-w-full truncate hover:border-primary">
                    {app.organization.name}
                  </Badge>
                ) : (
                  <span className="text-xs text-primary underline-offset-2 hover:underline">
                    Unassigned — assign
                  </span>
                )}
              </button>
            ),
          },
        ]
      : []),
    {
      header: "Type",
      className: "w-28",
      sortKey: "type",
      cell: (app) => <AppTypeBadge type={app.type} port={app.port} />,
    },
    {
      header: "Server",
      className: "w-28 text-xs",
      sortKey: "server",
      cell: (app) =>
        app.server ? (
          <Link to={`/servers/${app.server.id}`} className="truncate hover:underline">
            {app.server.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      header: "Health",
      className: "w-[22%]",
      // the row's status, not the heartbeat bar — "down" sites the sync marked
      // ERROR sort with the broken ones
      sortKey: "status",
      cell: (app) => {
        const health = healthById[app.id];
        const label = healthLabel(health);
        // a deploy in flight is this platform's own work, not the site's health
        const deploying = app.status === "DEPLOYING" || app.status === "BUILDING";

        return (
          <div className="space-y-1">
            <HeartbeatBar health={health} />
            <span className="flex min-w-0 items-center gap-1.5 text-xs">
              {deploying ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin text-warning" />
                  <span className="text-warning">{app.status.toLowerCase()}</span>
                </>
              ) : (
                <span className={label.className}>{label.text}</span>
              )}
              {health?.responseMs != null && (
                <span className="text-muted-foreground">· {health.responseMs}ms</span>
              )}
              {health?.lastError && health.state !== "up" && (
                <span className="truncate text-muted-foreground" title={health.lastError}>
                  · {health.lastError}
                </span>
              )}
            </span>
          </div>
        );
      },
    },
    {
      header: "Uptime",
      className: "w-24 text-xs",
      cell: (app) => {
        const uptime = healthById[app.id]?.uptime24h;
        return uptime == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span title="Successful checks in the last 24 hours">{uptime}%</span>
        );
      },
    },
    {
      header: "Last deploy",
      className: "w-28 text-xs",
      cell: (app) => {
        const at = app.deployments?.[0]?.createdAt;
        if (!at) return <span className="text-muted-foreground">—</span>;
        return <span title={new Date(at).toLocaleString()}>{ago(at)}</span>;
      },
    },
    {
      header: "",
      className: "w-16 text-right",
      cell: (app) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              aria-label={`Actions for ${app.name}`}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onClick={() => navigate(`/application/${app.id}`)}>
              <Eye className="mr-2 h-4 w-4" />
              Manage
            </DropdownMenuItem>

            {app.status === "RUNNING" ? (
              <DropdownMenuItem
                disabled={stopApp.isPending}
                onClick={() => handleStop(app.id, app.name)}
              >
                <Square className="mr-2 h-4 w-4" />
                Stop
              </DropdownMenuItem>
            ) : hasBeenDeployed(app) ? (
              <DropdownMenuItem
                disabled={startExistingApp.isPending}
                onClick={() => handleStartExisting(app.id, app.name)}
              >
                <Play className="mr-2 h-4 w-4" />
                Start
              </DropdownMenuItem>
            ) : null}

            {app.status === "RUNNING" && (
              <DropdownMenuItem
                disabled={restartApp.isPending}
                onClick={() => handleRestart(app.id, app.name)}
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Restart
              </DropdownMenuItem>
            )}

            {/* an imported site is supervised by whoever set it up, not by us —
                offering a redeploy would promise something we cannot do */}
            {!app.runtime && (
              <DropdownMenuItem
                disabled={startApp.isPending}
                onClick={() => handleStart(app.id, app.name)}
              >
                <Upload className="mr-2 h-4 w-4" />
                {app.status === "RUNNING" ? "Redeploy" : "Deploy and start"}
              </DropdownMenuItem>
            )}

            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={deleteApp.isPending || app.status === "RUNNING"}
              onClick={() => handleDelete(app.id, app.name)}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <TooltipProvider>
      <PageLayout
        title="Apps"
        description="Manage your applications and services."
        actions={
          <div className="flex items-center gap-2">
            {superAdmin && (
              <Button
                variant="outline"
                onClick={() => syncApps.mutate()}
                disabled={syncApps.isPending}
              >
                {syncApps.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                {syncApps.isPending ? "Syncing…" : "Sync Apps"}
              </Button>
            )}
            <Link to="/add-app">
            <Button className="bg-gradient-primary shadow-glow transition-all duration-300 hover:shadow-elegant">
              <Plus className="mr-2 h-4 w-4" />
              Add App
              </Button>
            </Link>
          </div>
        }
      >
        {/* the imported-sites workflow: fifty unassigned rows, one owner */}
        {superAdmin && selectedIds.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-border/60 bg-muted/40 p-3">
            <span className="text-sm font-medium">{selectedIds.length} selected</span>
            <OrganizationCombobox
              value={bulkOrgId || null}
              onChange={(id) => setBulkOrgId(id ?? "")}
              placeholder="Assign to organization"
              className="w-64"
            />
            <Button
              size="sm"
              disabled={!bulkOrgId || bulkAssign.isPending}
              onClick={() => bulkAssign.mutate({ ids: selectedIds, organizationId: bulkOrgId || null })}
            >
              {bulkAssign.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Assign
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelectedIds([])}>
              Clear
            </Button>
          </div>
        )}

        <DataTable
          columns={columns}
          rows={applications}
          rowKey={(app) => app.id}
          query={query}
          pagination={applicationsData?.pagination}
          isLoading={isLoading}
          searchPlaceholder="Search name or domain…"
          empty="No applications yet — deploy your first one."
          toolbar={<OrganizationFilter query={query} />}
        />

        <Dialog open={!!assignTarget} onOpenChange={(open) => !open && setAssignTarget(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Assign organization</DialogTitle>
              <DialogDescription>
                Choose which organization owns {assignTarget?.name}. Its members get to see and manage it.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <OrganizationCombobox value={assignOrgId} onChange={setAssignOrgId} noneLabel="Unassigned" />
              <div className="flex items-center justify-end space-x-3">
                <Button variant="outline" onClick={() => setAssignTarget(null)}>
                  Cancel
                </Button>
                <Button
                  disabled={bulkAssign.isPending}
                  onClick={() =>
                    assignTarget && bulkAssign.mutate({ ids: [assignTarget.id], organizationId: assignOrgId })
                  }
                >
                  {bulkAssign.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

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
