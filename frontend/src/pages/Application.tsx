import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
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
  Loader2
} from "lucide-react";
import { Link } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { useApplications, useStartApplication, useStopApplication, useRestartApplication, useDeleteApplication } from "@/hooks/useApplications";
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
  const [searchTerm, setSearchTerm] = useState("");
  const [confirmAction, setConfirmAction] = useState<{
    type: 'start' | 'stop' | 'restart' | 'delete';
    appId: string;
    appName: string;
  } | null>(null);
  const { toast } = useToast();
  
  // API hooks
  const { data: applicationsData, isLoading, error } = useApplications();
  const startApp = useStartApplication();
  const stopApp = useStopApplication();
  const restartApp = useRestartApplication();
  const deleteApp = useDeleteApplication();

  const applications = applicationsData?.data || [];
  const filteredApps = applications.filter(app =>
    searchTerm.toLowerCase() === "" ||
    app.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    app.domain.toLowerCase().includes(searchTerm.toLowerCase()) ||
    app.type.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleStart = async (id: string, name: string) => {
    setConfirmAction({ type: 'start', appId: id, appName: name });
  };

  const handleStop = async (id: string, name: string) => {
    setConfirmAction({ type: 'stop', appId: id, appName: name });
  };

  const handleRestart = async (id: string, name: string) => {
    setConfirmAction({ type: 'restart', appId: id, appName: name });
  };

  const handleDelete = async (id: string, name: string) => {
    setConfirmAction({ type: 'delete', appId: id, appName: name });
  };

  const executeAction = async () => {
    if (!confirmAction) return;

    try {
      switch (confirmAction.type) {
        case 'start':
          await startApp.mutateAsync(confirmAction.appId);
          break;
        case 'stop':
          await stopApp.mutateAsync(confirmAction.appId);
          break;
        case 'restart':
          await restartApp.mutateAsync(confirmAction.appId);
          break;
        case 'delete':
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
    
    switch (type) {
      case 'start':
        return {
          title: 'Start Application',
          description: `Are you sure you want to start "${appName}"? This will deploy and run the application.`,
          actionText: 'Start Application',
          variant: 'default' as const,
        };
      case 'stop':
        return {
          title: 'Stop Application',
          description: `Are you sure you want to stop "${appName}"? This will shut down the running application.`,
          actionText: 'Stop Application',
          variant: 'destructive' as const,
        };
      case 'restart':
        return {
          title: 'Restart Application',
          description: `Are you sure you want to restart "${appName}"? This will stop and then start the application.`,
          actionText: 'Restart Application',
          variant: 'default' as const,
        };
      case 'delete':
        return {
          title: 'Delete Application',
          description: `Are you sure you want to delete "${appName}"? This action cannot be undone and will permanently remove the application and all its data.`,
          actionText: 'Delete Application',
          variant: 'destructive' as const,
        };
    }
  };

  const runningApps = filteredApps.filter(app => app.status === "RUNNING").length;
  const errorApps = filteredApps.filter(app => app.status === "ERROR").length;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-2">Error Loading Applications</h3>
          <p className="text-muted-foreground">Failed to load applications. Please try again.</p>
        </div>
      </div>
    );
  }

  const dialogContent = getDialogContent();

  return (
    <TooltipProvider>
      <div className="space-y-8 animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold bg-gradient-primary bg-clip-text text-transparent">
              Applications
            </h1>
            <p className="text-muted-foreground">
              Manage your applications and services.
            </p>
          </div>
          <Link to="/add-app">
            <Button className="bg-gradient-primary shadow-glow hover:shadow-elegant transition-all duration-300">
              <Plus className="h-4 w-4 mr-2" />
              Deploy New App
            </Button>
          </Link>
        </div>

        {/* Search */}
        <div className="flex items-center space-x-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search applications..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex items-center space-x-2 text-sm text-muted-foreground">
            <Activity className="h-4 w-4 text-success" />
            <span>{runningApps} running</span>
            {errorApps > 0 && (
              <>
                <AlertCircle className="h-4 w-4 text-destructive ml-4" />
                <span>{errorApps} errors</span>
              </>
            )}
          </div>
        </div>

        {/* Apps Section */}
        <div className="space-y-6">
          {filteredApps.length === 0 ? (
            <Card className="bg-gradient-card border-border/50">
              <CardContent className="flex flex-col items-center justify-center py-12">
                <Zap className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">No Applications Yet</h3>
                <p className="text-muted-foreground text-center max-w-md mb-4">
                  Get started by deploying your first application to the platform.
                </p>
                <Link to="/add-app">
                  <Button className="bg-gradient-primary">
                    <Plus className="h-4 w-4 mr-2" />
                    Deploy Your First App
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Domain</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Port</TableHead>
                    <TableHead>Last Deployment</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredApps.map((app) => (
                    <TableRow key={app.id}>
                      <TableCell className="font-medium">
                        <Link 
                          to={`/application/${app.id}`}
                          className="hover:text-primary transition-colors"
                        >
                          {app.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center space-x-2">
                          <Globe className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm">{app.domain}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                          {app.type}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center space-x-2">
                          <div className={`w-2 h-2 rounded-full ${
                            app.status === 'RUNNING' ? 'bg-green-500' : 
                            app.status === 'STOPPED' ? 'bg-gray-500' : 
                            app.status === 'ERROR' ? 'bg-red-500' :
                            app.status === 'DEPLOYING' ? 'bg-yellow-500' :
                            'bg-blue-500'
                          }`} />
                          <span className="capitalize">{app.status.toLowerCase()}</span>
                        </div>
                      </TableCell>
                      <TableCell>{app.port || '-'}</TableCell>
                      <TableCell>
                        {app.deployments && app.deployments.length > 0 
                          ? new Date(app.deployments[0].createdAt).toLocaleDateString()
                          : '-'
                        }
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center space-x-2">
                          {app.status === 'RUNNING' ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleStop(app.id, app.name)}
                              disabled={stopApp.isPending}
                              className="h-8 w-8 p-0"
                            >
                              {stopApp.isPending ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Square className="h-4 w-4" />
                              )}
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleStart(app.id, app.name)}
                              disabled={startApp.isPending}
                              className="h-8 w-8 p-0"
                            >
                              {startApp.isPending ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Play className="h-4 w-4" />
                              )}
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRestart(app.id, app.name)}
                            disabled={restartApp.isPending}
                            className="h-8 w-8 p-0"
                          >
                            {restartApp.isPending ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <RotateCcw className="h-4 w-4" />
                            )}
                          </Button>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleDelete(app.id, app.name)}
                                disabled={deleteApp.isPending || app.status === 'RUNNING'}
                                className="h-8 w-8 p-0 text-destructive hover:text-destructive disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {deleteApp.isPending ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Trash2 className="h-4 w-4" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            {app.status === 'RUNNING' && (
                              <TooltipContent>
                                <p>Stop the application first before deleting</p>
                              </TooltipContent>
                            )}
                          </Tooltip>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {/* Confirmation Dialog */}
        {confirmAction && dialogContent && (
          <AlertDialog open={!!confirmAction} onOpenChange={() => setConfirmAction(null)}>
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
                  className={`${dialogContent.variant}`}
                  disabled={startApp.isPending || stopApp.isPending || restartApp.isPending || deleteApp.isPending}
                >
                  {startApp.isPending || stopApp.isPending || restartApp.isPending || deleteApp.isPending ? (
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
      </div>
    </TooltipProvider>
  );
}