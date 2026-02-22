import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ArrowLeft,
  Play,
  Square,
  RotateCcw,
  Trash2,
  Settings,
  Terminal,
  Activity,
  Globe,
  HardDrive,
  Cpu,
  Clock,
  GitBranch,
  Code,
  Server,
  AlertCircle,
  CheckCircle,
  Info,
  Loader2,
  RefreshCw,
  Download,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Calendar,
  Database,
  Network,
  FileText,
  AlertTriangle,
  Zap,
  Wifi,
  WifiOff
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useApplicationStatus, useStartApplication, useStartExistingApplication, useStopApplication, useRestartApplication, useDeleteApplication, useUpdateApplication } from "@/hooks/useApplications";
import { useApplicationLogs, useBuildLogStatus, useCreateTestBuildLog } from "@/hooks/useLogs";
import { useQueryClient } from "@tanstack/react-query";
import { Application, UpdateApplicationData, hasBeenDeployed } from "@/lib/applications";
import DeploymentHistory from "@/components/DeploymentHistory";
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

interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
}

interface ApplicationLogs {
  build?: string;
  combined?: string;
  out?: string;
  error?: string;
}

export default function ApplicationDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  
  // State
  const [activeTab, setActiveTab] = useState("overview");
  const [selectedLogType, setSelectedLogType] = useState("combined");
  const [logLines, setLogLines] = useState(100);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showRawLogs, setShowRawLogs] = useState(false);
  const [logs, setLogs] = useState<ApplicationLogs>({});
  const [confirmAction, setConfirmAction] = useState<{
    type: 'start' | 'start-existing' | 'stop' | 'restart' | 'delete';
    appName: string;
  } | null>(null);

  // API hooks
  const { application, isLoading, error } = useApplicationStatus(id!);
  const startApp = useStartApplication();
  const startExistingApp = useStartExistingApplication();
  const stopApp = useStopApplication();
  const restartApp = useRestartApplication();
  const deleteApp = useDeleteApplication();

  // Logs hooks
  const { data: logsData, isLoading: logsLoading, refetch: refetchLogs } = useApplicationLogs(id!, selectedLogType, logLines);
  const { data: buildLogStatus } = useBuildLogStatus(id!);
  const createTestLog = useCreateTestBuildLog();

  // Update logs when data changes
  useEffect(() => {
    if (logsData?.data?.logs) {
      setLogs(prev => ({
        ...prev,
        [selectedLogType]: logsData.data.logs
      }));
    }
  }, [logsData, selectedLogType]);

  const fetchLogs = () => {
    refetchLogs();
  };

  const refetchApplication = () => {
    // The real-time monitoring will handle refetching automatically
    // This is just a placeholder for manual refresh if needed
  };

  // Handle actions
  const handleStart = () => {
    if (!application) return;
    setConfirmAction({ type: 'start', appName: application.name });
  };

  const handleStartExisting = () => {
    if (!application) return;
    setConfirmAction({ type: 'start-existing', appName: application.name });
  };

  const handleStop = () => {
    if (!application) return;
    setConfirmAction({ type: 'stop', appName: application.name });
  };

  const handleRestart = () => {
    if (!application) return;
    setConfirmAction({ type: 'restart', appName: application.name });
  };

  const handleDelete = () => {
    if (!application) return;
    setConfirmAction({ type: 'delete', appName: application.name });
  };

  const executeAction = async () => {
    if (!confirmAction || !id) return;

    try {
      switch (confirmAction.type) {
        case 'start':
          await startApp.mutateAsync(id);
          break;
        case 'start-existing':
          await startExistingApp.mutateAsync(id);
          break;
        case 'stop':
          await stopApp.mutateAsync(id);
          break;
        case 'restart':
          await restartApp.mutateAsync(id);
          break;
        case 'delete':
          await deleteApp.mutateAsync(id);
          navigate('/');
          break;
      }
    } catch (error) {
      // Error is handled by the mutation
    } finally {
      setConfirmAction(null);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'running':
        return 'bg-green-500';
      case 'stopped':
        return 'bg-gray-500';
      case 'error':
        return 'bg-red-500';
      case 'deploying':
        return 'bg-yellow-500';
      default:
        return 'bg-blue-500';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'running':
        return <Wifi className="h-4 w-4 text-green-500" />;
      case 'stopped':
        return <WifiOff className="h-4 w-4 text-gray-500" />;
      case 'error':
        return <AlertCircle className="h-4 w-4 text-red-500" />;
      case 'deploying':
        return <Loader2 className="h-4 w-4 text-yellow-500 animate-spin" />;
      default:
        return <Info className="h-4 w-4 text-blue-500" />;
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({
      title: 'Copied',
      description: 'Text copied to clipboard',
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (error || !application) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-2">Application Not Found</h3>
          <p className="text-muted-foreground mb-4">The application you're looking for doesn't exist.</p>
          <Button onClick={() => navigate('/')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Applications
          </Button>
        </div>
      </div>
    );
  }

  const dialogContent = confirmAction ? {
    start: {
      title: hasBeenDeployed(application) ? 'Redeploy & Start Application' : 'Deploy & Start Application',
      description: hasBeenDeployed(application) 
        ? `Are you sure you want to redeploy and start "${confirmAction.appName}"? This will rebuild and run the application.`
        : `Are you sure you want to deploy and start "${confirmAction.appName}"? This will build and run the application for the first time.`,
      actionText: hasBeenDeployed(application) ? 'Redeploy & Start' : 'Deploy & Start',
      variant: 'default' as const,
    },
    'start-existing': {
      title: 'Start Application',
      description: `Are you sure you want to start "${confirmAction.appName}"? This will start the existing built application without rebuilding.`,
      actionText: 'Start Application',
      variant: 'default' as const,
    },
    stop: {
      title: 'Stop Application',
      description: `Are you sure you want to stop "${confirmAction.appName}"? This will shut down the running application.`,
      actionText: 'Stop Application',
      variant: 'destructive' as const,
    },
    restart: {
      title: 'Restart Application',
      description: `Are you sure you want to restart "${confirmAction.appName}"? This will stop and then start the application.`,
      actionText: 'Restart Application',
      variant: 'default' as const,
    },
    delete: {
      title: 'Delete Application',
      description: `Are you sure you want to delete "${confirmAction.appName}"? This action cannot be undone and will permanently remove the application and all its data.`,
      actionText: 'Delete Application',
      variant: 'destructive' as const,
    },
  }[confirmAction.type] : null;

  return (
    <TooltipProvider>
      <div className="space-y-6 animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate('/')}
              className="h-8 w-8 p-0"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-3xl font-bold bg-gradient-primary bg-clip-text text-transparent">
                {application.name}
              </h1>
              <p className="text-muted-foreground">
                Application Details & Management
              </p>
            </div>
          </div>
          
          <div className="flex items-center space-x-2">
            <Button
              variant="outline"
              onClick={() => refetchApplication()}
              disabled={isRefreshing}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            
            {/* Application Action Buttons */}
            {application.status === 'RUNNING' ? (
              // Running application - Show Stop button
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="destructive"
                    onClick={handleStop}
                    disabled={stopApp.isPending}
                  >
                    {stopApp.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Square className="h-4 w-4 mr-2" />
                    )}
                    Stop
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Stop the running application</p>
                </TooltipContent>
              </Tooltip>
            ) : hasBeenDeployed(application) ? (
              // Previously deployed but not running - Show both Start and Redeploy & Start
              <div className="flex items-center space-x-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      onClick={handleStartExisting}
                      disabled={startExistingApp.isPending}
                      className="bg-gradient-primary"
                    >
                      {startExistingApp.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Play className="h-4 w-4 mr-2" />
                      )}
                      Start
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Start the existing built application</p>
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      onClick={handleStart}
                      disabled={startApp.isPending}
                    >
                      {startApp.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <RotateCcw className="h-4 w-4 mr-2" />
                      )}
                      Redeploy & Start
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Rebuild and start the application</p>
                  </TooltipContent>
                </Tooltip>
              </div>
            ) : (
              // Never deployed - Show Deploy & Start
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={handleStart}
                    disabled={startApp.isPending}
                    className="bg-gradient-primary"
                  >
                    {startApp.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4 mr-2" />
                    )}
                    Deploy & Start
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Deploy and start the application for the first time</p>
                </TooltipContent>
              </Tooltip>
            )}
            
            {/* Restart button - only show if application is running */}
            {application.status === 'RUNNING' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    onClick={handleRestart}
                    disabled={restartApp.isPending}
                  >
                    {restartApp.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <RotateCcw className="h-4 w-4 mr-2" />
                    )}
                    Restart
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Restart the application</p>
                </TooltipContent>
              </Tooltip>
            )}
            
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  disabled={application.status === 'RUNNING'}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Application</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to delete "{application.name}"? This action cannot be undone and will permanently remove the application and all its data.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => handleDelete()}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    disabled={deleteApp.isPending}
                  >
                    {deleteApp.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : null}
                    Delete Application
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        {/* Status Banner */}
        <Card className="bg-gradient-card border-border/50">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-4">
                {getStatusIcon(application.status)}
                <div>
                  <h3 className="text-lg font-semibold">Status: {application.status}</h3>
                  <p className="text-muted-foreground">
                    {application.status === 'RUNNING' ? 'Application is running and accessible' :
                     application.status === 'STOPPED' ? 'Application is stopped and not accessible' :
                     application.status === 'ERROR' ? 'Application encountered an error' :
                     'Application is being deployed'}
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                <div className={`w-3 h-3 rounded-full ${getStatusColor(application.status)}`} />
                <span className="text-sm font-medium capitalize">{application.status?.toLowerCase()}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Main Content */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="deployments">Deployments</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {/* Basic Info */}
              <Card className="bg-gradient-card border-border/50">
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <Info className="h-5 w-5 text-primary" />
                    <span>Basic Information</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-muted-foreground">Name</label>
                    <p className="font-medium">{application.name}</p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-muted-foreground">Type</label>
                    <Badge variant="secondary">{application.type}</Badge>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-muted-foreground">Deployment Mode</label>
                    <p className="font-medium">
                      {application.type === 'STATIC' ? 'Static Site (S3)' : 'Runtime Container'}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-muted-foreground">Domain</label>
                    <div className="flex items-center space-x-2">
                      <Globe className="h-4 w-4 text-muted-foreground" />
                      <span className="font-mono text-sm">{application.domain}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => copyToClipboard(application.domain)}
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Runtime / Static Info */}
              <Card className="bg-gradient-card border-border/50">
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <Server className="h-5 w-5 text-primary" />
                    <span>{application.type === 'STATIC' ? 'Static Site' : 'Runtime Information'}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {application.type === 'STATIC' ? (
                    <>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-muted-foreground">Static Site URL</label>
                        {application.staticSiteUrl ? (
                          <div className="flex items-center space-x-2">
                            <span className="font-mono text-xs break-all">{application.staticSiteUrl}</span>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => copyToClipboard(application.staticSiteUrl || '')}
                            >
                              <Copy className="h-3 w-3" />
                            </Button>
                          </div>
                        ) : (
                          <p className="font-medium text-muted-foreground">Not deployed yet</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-muted-foreground">Hosting</label>
                        <p className="font-medium">Object storage (S3-compatible)</p>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-muted-foreground">Port</label>
                        <p className="font-medium">{application.port || 'Not configured'}</p>
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-muted-foreground">Memory Usage</label>
                        <p className="font-medium">Not available</p>
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-muted-foreground">CPU Usage</label>
                        <p className="font-medium">Not available</p>
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-muted-foreground">Uptime</label>
                        <p className="font-medium">Not available</p>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              {/* Repository Info */}
              <Card className="bg-gradient-card border-border/50">
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <GitBranch className="h-5 w-5 text-primary" />
                    <span>Repository</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-muted-foreground">Repository</label>
                    <p className="font-mono text-sm break-all">{application.repository || 'Not configured'}</p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-muted-foreground">Branch</label>
                    <p className="font-medium">{application.branch || 'main'}</p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-muted-foreground">Build Command</label>
                    <p className="font-mono text-sm">{application.buildCommand || 'Not configured'}</p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-muted-foreground">Start Command</label>
                    <p className="font-mono text-sm">{application.startCommand || 'Not configured'}</p>
                  </div>
                </CardContent>
              </Card>

              {/* Deployment Info */}
              <Card className="bg-gradient-card border-border/50">
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <Zap className="h-5 w-5 text-primary" />
                    <span>Deployment</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-muted-foreground">Last Deployment</label>
                    <p className="font-medium">
                      {application.deployments && application.deployments.length > 0 
                        ? new Date(application.deployments[0].createdAt).toLocaleString()
                        : 'Never deployed'
                      }
                    </p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-muted-foreground">Deployment Status</label>
                    <Badge variant="outline">
                      {application.deployments && application.deployments.length > 0 
                        ? application.deployments[0].status 
                        : 'Not deployed'
                      }
                    </Badge>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-muted-foreground">Total Deployments</label>
                    <p className="font-medium">{application.deployments?.length || 0}</p>
                  </div>
                </CardContent>
              </Card>

              {/* Environment Variables */}
              <Card className="bg-gradient-card border-border/50">
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <Settings className="h-5 w-5 text-primary" />
                    <span>Environment Variables</span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-muted-foreground">Environment Variables</label>
                    <Textarea
                      value={application.envVars ? JSON.stringify(application.envVars, null, 2) : 'No environment variables configured'}
                      readOnly
                      className="font-mono text-xs"
                      rows={6}
                    />
                  </div>
                </CardContent>
              </Card>

              {/* Quick Actions */}
              <Card className="bg-gradient-card border-border/50">
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <Activity className="h-5 w-5 text-primary" />
                    <span>Quick Actions</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    onClick={() => setActiveTab("logs")}
                  >
                    <Terminal className="h-4 w-4 mr-2" />
                    View Logs
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    onClick={() => setActiveTab("deployments")}
                  >
                    <Zap className="h-4 w-4 mr-2" />
                    View Deployments
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    onClick={() => setActiveTab("settings")}
                  >
                    <Settings className="h-4 w-4 mr-2" />
                    Edit Settings
                  </Button>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Logs Tab */}
          <TabsContent value="logs" className="space-y-6">
            <Card className="bg-gradient-card border-border/50">
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Terminal className="h-5 w-5 text-primary" />
                  <span>Application Logs</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Log Controls */}
                <div className="flex items-center space-x-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Log Type</label>
                    <Select value={selectedLogType} onValueChange={setSelectedLogType}>
                      <SelectTrigger className="w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="combined">Combined Logs</SelectItem>
                        <SelectItem value="out">Output Logs</SelectItem>
                        <SelectItem value="error">Error Logs</SelectItem>
                        <SelectItem value="build">Build Logs</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Lines</label>
                    <Select value={logLines.toString()} onValueChange={(value) => setLogLines(parseInt(value))}>
                      <SelectTrigger className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="50">50 lines</SelectItem>
                        <SelectItem value="100">100 lines</SelectItem>
                        <SelectItem value="200">200 lines</SelectItem>
                        <SelectItem value="500">500 lines</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div className="flex items-center space-x-2">
                    <Button
                      variant="outline"
                      onClick={fetchLogs}
                      disabled={isRefreshing}
                    >
                      <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? "animate-spin" : ""}`} />
                      Refresh
                    </Button>
                    
                    <Button
                      variant="outline"
                      onClick={() => setShowRawLogs(!showRawLogs)}
                    >
                      {showRawLogs ? <EyeOff className="h-4 w-4 mr-2" /> : <Eye className="h-4 w-4 mr-2" />}
                      {showRawLogs ? 'Formatted' : 'Raw'}
                    </Button>
                    
                    <Button
                      variant="outline"
                      onClick={() => copyToClipboard(logs[selectedLogType as keyof ApplicationLogs] || '')}
                    >
                      <Copy className="h-4 w-4 mr-2" />
                      Copy
                    </Button>
                    
                    <Button variant="outline">
                      <Download className="h-4 w-4 mr-2" />
                      Download
                    </Button>
                  </div>
                </div>

                {/* Log Display */}
                <div className="border rounded-md">
                  <ScrollArea className="h-96">
                    <div className="p-4">
                      {logs[selectedLogType as keyof ApplicationLogs] ? (
                        <pre className="text-sm font-mono whitespace-pre-wrap">
                          {logs[selectedLogType as keyof ApplicationLogs]}
                        </pre>
                      ) : (
                        <div className="text-center text-muted-foreground py-8">
                          <Terminal className="h-8 w-8 mx-auto mb-2" />
                          <p>No logs available for {selectedLogType}</p>
                        </div>
                      )}
                    </div>
                  </ScrollArea>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Deployments Tab */}
          <TabsContent value="deployments" className="space-y-6">
            <DeploymentHistory application={application} />
          </TabsContent>

          {/* Settings Tab */}
          <TabsContent value="settings" className="space-y-6">
            <Card className="bg-gradient-card border-border/50">
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Settings className="h-5 w-5 text-primary" />
                  <span>Application Settings</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <ApplicationSettingsForm application={application} />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

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
                  className={dialogContent.variant === 'destructive' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''}
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

// Application Settings Form Component
interface ApplicationSettingsFormProps {
  application: Application;
}

function ApplicationSettingsForm({ application }: ApplicationSettingsFormProps) {
  const [formData, setFormData] = useState({
    buildCommand: application?.buildCommand || '',
    startCommand: application?.startCommand || '',
    port: application?.port?.toString() || '',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();
  const updateApp = useUpdateApplication();
  const queryClient = useQueryClient();

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!application) return;

    setIsSubmitting(true);
    
    try {
      const updateData: UpdateApplicationData = {
        buildCommand: formData.buildCommand || undefined,
        startCommand: formData.startCommand || undefined,
        port: formData.port ? parseInt(formData.port) : undefined,
      };

      await updateApp.mutateAsync({ id: application.id, data: updateData });
      
      toast({
        title: 'Success',
        description: 'Application settings updated successfully',
      });
      
      // Refetch application data
      queryClient.invalidateQueries({ queryKey: ['application', application.id] });
      
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to update application settings',
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReset = () => {
    setFormData({
      buildCommand: application?.buildCommand || '',
      startCommand: application?.startCommand || '',
      port: application?.port?.toString() || '',
    });
  };

  const hasChanges = () => {
    return (
      formData.buildCommand !== (application?.buildCommand || '') ||
      formData.startCommand !== (application?.startCommand || '') ||
      formData.port !== (application?.port?.toString() || '')
    );
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Build Command */}
      <div className="space-y-2">
        <label className="text-sm font-medium">
          Build Command
          <span className="text-muted-foreground ml-1">(optional)</span>
        </label>
        <Input
          value={formData.buildCommand}
          onChange={(e) => handleInputChange('buildCommand', e.target.value)}
          placeholder="yarn build"
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">
          Command to build your application (e.g., yarn build, npm run build)
        </p>
      </div>

      {/* Start Command */}
      <div className="space-y-2">
        <label className="text-sm font-medium">
          Start Command
          <span className="text-muted-foreground ml-1">(optional)</span>
        </label>
        <Input
          value={formData.startCommand}
          onChange={(e) => handleInputChange('startCommand', e.target.value)}
          placeholder="yarn start"
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">
          Command to start your application (e.g., yarn start, npm start, node app.js)
        </p>
      </div>

      {/* Port */}
      <div className="space-y-2">
        <label className="text-sm font-medium">
          Port
          <span className="text-muted-foreground ml-1">(optional)</span>
        </label>
        <Input
          type="number"
          value={formData.port}
          onChange={(e) => handleInputChange('port', e.target.value)}
          placeholder="3000"
          min="1"
          max="65535"
        />
        <p className="text-xs text-muted-foreground">
          Port number for your application (1-65535)
        </p>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center justify-between pt-4 border-t">
        <div className="flex items-center space-x-2">
          <Button
            type="button"
            variant="outline"
            onClick={handleReset}
            disabled={!hasChanges() || isSubmitting}
          >
            Reset
          </Button>
          {hasChanges() && (
            <Badge variant="secondary" className="text-xs">
              Unsaved changes
            </Badge>
          )}
        </div>
        
        <div className="flex items-center space-x-2">
          <Button
            type="submit"
            disabled={!hasChanges() || isSubmitting}
            className="bg-gradient-primary"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Settings className="h-4 w-4 mr-2" />
                Save Changes
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Help Section */}
      <div className="bg-muted/50 rounded-lg p-4 space-y-3">
        <h4 className="text-sm font-medium">Help & Examples</h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div>
            <p className="font-medium mb-1">Node.js</p>
            <p className="text-muted-foreground">Build: yarn build</p>
            <p className="text-muted-foreground">Start: yarn start</p>
          </div>
          <div>
            <p className="font-medium mb-1">React</p>
            <p className="text-muted-foreground">Build: yarn build</p>
            <p className="text-muted-foreground">Start: yarn start</p>
          </div>
          <div>
            <p className="font-medium mb-1">Vue.js</p>
            <p className="text-muted-foreground">Build: yarn build</p>
            <p className="text-muted-foreground">Start: yarn run serve</p>
          </div>
        </div>
      </div>
    </form>
  );
} 
