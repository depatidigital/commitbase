import { useState, useEffect, useRef, useMemo } from "react";
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
  WifiOff,
  Upload,
  KeyRound
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useApplicationStatus, useStartApplication, useStartExistingApplication, useStopApplication, useRestartApplication, useUpdateApplication, useApplicationHostname, useSetupApplicationDns } from "@/hooks/useApplications";
import { useApplicationLogs, useLiveLogs, useBuildLogStatus, useCreateTestBuildLog } from "@/hooks/useLogs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Application, DetectedProject, UpdateApplicationData, UploadEntry, getAppDetection, hasBeenDeployed } from "@/lib/applications";
import { AppSetupCard } from "@/components/AppSetupCard";
import { AppEnvironment, type EnvStatus } from "@/components/AppEnvironment";
import DeploymentHistory, { deploymentStatusLabel } from "@/components/DeploymentHistory";
import { ReuploadDialog } from "@/components/ReuploadDialog";
import { ReleasesCard } from "@/components/ReleasesCard";
import { SiteFilesCard } from "@/components/SiteFilesCard";
import { SourcePicker } from "@/components/SourcePicker";
import { DangerZoneCard } from "@/components/DangerZoneCard";
import { locale, t } from "@/lib/i18n";
import { parseAnsi, stripAnsi } from "@/lib/ansi";
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
} from "@/components/ui/alert-dialog";

interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
}

/** Displayed word for an app status; the raw value stays for logic. */
const STATUS_LABELS: Record<string, string> = {
  RUNNING: t("Running"),
  STOPPED: t("Stopped"),
  ERROR: t("Error"),
  DEPLOYING: t("Deploying"),
  BUILDING: t("Building"),
};

const LOG_TYPE_LABELS: Record<string, string> = {
  combined: t("Combined Logs"),
  out: t("Output Logs"),
  error: t("Error Logs"),
  build: t("Build Logs"),
};

/** Label left, value right — every line of the overview card. */
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-start justify-between gap-3 border-b border-border/60 py-2 text-sm">
    <span className="shrink-0 text-muted-foreground">{label}</span>
    <div className="min-w-0 text-right">{children}</div>
  </div>
);

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
  const [showRawLogs, setShowRawLogs] = useState(false);
  const [logs, setLogs] = useState<ApplicationLogs>({});
  const [reuploadOpen, setReuploadOpen] = useState(false);
  // files dropped on the empty-site card, handed to the upload dialog
  const [droppedFiles, setDroppedFiles] = useState<UploadEntry[]>();
  const [confirmAction, setConfirmAction] = useState<{
    type: 'start' | 'start-existing' | 'stop' | 'restart';
    appName: string;
  } | null>(null);

  // API hooks
  const { application, isLoading, error } = useApplicationStatus(id!);
  // keeps polling until the hostname answers, then settles
  const { data: hostname } = useApplicationHostname(id!, true);
  const setupDns = useSetupApplicationDns();
  const startApp = useStartApplication();
  const startExistingApp = useStartExistingApplication();
  const stopApp = useStopApplication();
  const restartApp = useRestartApplication();

  // Logs hooks
  // a static site has no process, so the build log is the only one it has
  const logType = application?.type === 'STATIC' ? 'build' : selectedLogType;
  // pm2 apps stream live, and only while the Logs tab is open; the rest poll
  const liveLogs = application?.runtime === 'PM2' && logType !== 'build';
  const live = useLiveLogs(id!, logType, logLines, liveLogs && activeTab === 'logs');
  const { data: logsData, isLoading: logsLoading, refetch: refetchLogs } = useApplicationLogs(id!, logType, logLines, !liveLogs);
  const shownLogs = liveLogs ? live.error ?? live.text : logs[logType as keyof ApplicationLogs];
  const logSegments = useMemo(() => (shownLogs && !showRawLogs ? parseAnsi(shownLogs) : []), [shownLogs, showRawLogs]);
  const logsEndRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (liveLogs) logsEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [liveLogs, shownLogs]);
  const { data: buildLogStatus } = useBuildLogStatus(id!);
  const createTestLog = useCreateTestBuildLog();

  // What the code expects (env keys, database, commands), read from the repo as
  // it is now. For the setup card before the first deploy, and for Settings.
  const canDetect = !!application && !(application.type === 'STATIC' && !application.repository);
  const needsSetup = canDetect && !hasBeenDeployed(application!);
  const detection = useQuery({
    queryKey: ['application', id, 'detect'],
    queryFn: () => getAppDetection(id!),
    enabled: canDetect && (needsSetup || activeTab === 'environment' || activeTab === 'settings'),
    staleTime: 5 * 60_000,
    retry: false,
  });
  // the Environment tab's form, for the setup checklist on the Overview tab
  const [envStatus, setEnvStatus] = useState<EnvStatus>({ missing: [], dirty: false });

  // Update logs when data changes
  useEffect(() => {
    if (logsData?.data?.logs) {
      setLogs(prev => ({
        ...prev,
        [logType]: logsData.data.logs
      }));
    }
  }, [logsData, logType]);

  const fetchLogs = () => {
    refetchLogs();
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
      title: t('Copied'),
      description: t('Text copied to clipboard'),
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
          <h3 className="text-lg font-semibold mb-2">{t("App Not Found")}</h3>
          <p className="text-muted-foreground mb-4">{t("The application you're looking for doesn't exist.")}</p>
          <Button onClick={() => navigate('/')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t("Back to Apps")}
          </Button>
        </div>
      </div>
    );
  }

  const isStatic = application.type === 'STATIC';
  // a static site deployed from an upload: the upload is the deploy — no
  // build, no process, so no start/stop/restart, logs or build settings
  const uploadedSite = isStatic && !application.repository;
  const hasSiteFiles = !!(application.staticBucket || application.staticSiteUrl);
  const hasSiteBucket = isStatic && !!application.staticBucket;
  // something is published at the hostname: a static site with files, or a
  // runtime app that is up
  const published = isStatic ? hasSiteFiles : application.status === 'RUNNING';
  const uploadLabel = !uploadedSite
    ? t("Upload files again")
    : hasSiteFiles
      ? t("Deploy new version")
      : t("Upload files");
  // the reason is on the deployment row; the banner saying "error" alone
  // leaves the user hunting for it
  const lastDeployment = application.deployments?.[0];
  const failureReason =
    application.status === 'ERROR' && lastDeployment?.status === 'FAILED'
      ? (lastDeployment.deployLogs || lastDeployment.buildLogs?.trim().split('\n').slice(-3).join('\n'))
      : undefined;

  const dialogContent = confirmAction ? {
    // a static site from a repo: built and published, never "started"
    start: isStatic ? {
      title: hasBeenDeployed(application) ? t('Redeploy Site') : t('Deploy Site'),
      description: t("Build \"{name}\" from {branch} and publish the result to the site.", {
        name: confirmAction.appName,
        branch: application.branch || 'main',
      }),
      actionText: hasBeenDeployed(application) ? t('Redeploy') : t('Deploy'),
      variant: 'default' as const,
    } : {
      title: hasBeenDeployed(application) ? t('Redeploy & Start App') : t('Deploy & Start App'),
      description: hasBeenDeployed(application) 
        ? t("Are you sure you want to redeploy and start \"{name}\"? This will rebuild and run the application.", { name: confirmAction.appName })
        : t("Are you sure you want to deploy and start \"{name}\"? This will build and run the application for the first time.", { name: confirmAction.appName }),
      actionText: hasBeenDeployed(application) ? t('Redeploy & Start') : t('Deploy & Start'),
      variant: 'default' as const,
    },
    'start-existing': {
      title: t('Start App'),
      description: t("Are you sure you want to start \"{name}\"? This will start the existing built application without rebuilding.", { name: confirmAction.appName }),
      actionText: t('Start App'),
      variant: 'default' as const,
    },
    stop: {
      title: t('Stop App'),
      description: t("Are you sure you want to stop \"{name}\"? This will shut down the running application.", { name: confirmAction.appName }),
      actionText: t('Stop App'),
      variant: 'destructive' as const,
    },
    restart: {
      title: t('Restart App'),
      description: t("Are you sure you want to restart \"{name}\"? This will stop and then start the application.", { name: confirmAction.appName }),
      actionText: t('Restart App'),
      variant: 'default' as const,
    },
  }[confirmAction.type] : null;

  return (
    <TooltipProvider>
      <div className="space-y-6 animate-fade-in">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4">
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
              <div className="flex items-center gap-2">
                <h1 className="text-3xl font-bold bg-gradient-primary bg-clip-text text-transparent">
                  {application.name}
                </h1>
                {published && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0" asChild>
                        <a
                          href={`https://${application.domain}`}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={t("Visit site")}
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t("Visit site")}</p>
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
              <p className="text-muted-foreground">
                {t("App Details & Management")}
              </p>
            </div>
          </div>
          
          {/* no refresh button: the data refetches whenever the tab regains
              focus, and polls while a deploy runs */}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* deployed from an upload: new files are how it is redeployed,
                and the only way back after a failed upload */}
            {/* also while RUNNING: "running" only means the last write went
                through, not that the hostname reaches the files */}
            {uploadedSite && hasSiteFiles && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    onClick={() => startApp.mutate(application.id)}
                    disabled={startApp.isPending}
                  >
                    {startApp.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <RotateCcw className="h-4 w-4 mr-2" />
                    )}
                    {t("Republish")}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{t("Points the site back at the files already uploaded. Nothing is uploaded again.")}</p>
                </TooltipContent>
              </Tooltip>
            )}
            {!application.repository && (
              <Button
                variant={uploadedSite ? "default" : "outline"}
                className={uploadedSite ? "bg-gradient-primary" : undefined}
                onClick={() => setReuploadOpen(true)}
              >
                <Upload className="h-4 w-4 mr-2" />
                {uploadLabel}
              </Button>
            )}
            <ReuploadDialog
              application={application}
              title={uploadLabel}
              seed={droppedFiles}
              open={reuploadOpen}
              onOpenChange={setReuploadOpen}
            />

            {/* static sites have no process to start, stop or restart: an
                uploaded one redeploys by upload (above), a repo one by building */}
            {isStatic ? (
              !uploadedSite && (
                <Button onClick={handleStart} disabled={startApp.isPending} className="bg-gradient-primary">
                  {startApp.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4 mr-2" />
                  )}
                  {hasBeenDeployed(application) ? t("Redeploy") : t("Deploy")}
                </Button>
              )
            ) : application.status === 'RUNNING' ? (
              // Running application - Stop, or redeploy without downtime
              <div className="flex items-center space-x-2">
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
                      {t("Stop")}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t("Stop the running application")}</p>
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
                      {t("Redeploy")}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t("Build the latest code and switch over once it answers. The current release keeps serving meanwhile.")}</p>
                  </TooltipContent>
                </Tooltip>
              </div>
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
                      {t("Start")}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t("Start the existing built application")}</p>
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
                      {t("Redeploy & Start")}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{t("Rebuild and start the application")}</p>
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
                    {t("Deploy & Start")}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{t("Deploy and start the application for the first time")}</p>
                </TooltipContent>
              </Tooltip>
            )}
            
            {/* Restart button - only show if application is running */}
            {!isStatic && application.status === 'RUNNING' && (
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
                    {t("Restart")}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{t("Restart the application")}</p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        {/* Status Banner */}
        <Card className="bg-gradient-card border-border/50">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div className="flex min-w-0 items-center space-x-4">
                {getStatusIcon(application.status)}
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold">{t("Status: {status}", { status: STATUS_LABELS[application.status] ?? application.status })}</h3>
                  <p className="text-muted-foreground">
                    {uploadedSite && !hasSiteFiles ? t("No files yet — upload the site's build output (a folder with index.html).") :
                     application.status === 'RUNNING' ? t('App is running and accessible') :
                     application.status === 'STOPPED' ? t('App is stopped and not accessible') :
                     application.status === 'ERROR' ? t('App encountered an error') :
                     t('App is being deployed')}
                  </p>
                  {failureReason && (
                    <div className="mt-2 space-y-1">
                      <pre className="max-h-24 overflow-auto whitespace-pre-wrap font-mono text-xs text-destructive">
                        {failureReason}
                      </pre>
                      <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setActiveTab("deployments")}>
                        {t("View Deployments")}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center space-x-2">
                <div className={`w-3 h-3 rounded-full ${getStatusColor(application.status)}`} />
                <span className="text-sm font-medium capitalize">{STATUS_LABELS[application.status] ?? application.status?.toLowerCase()}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Main Content */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList
            className="grid w-full"
            style={{ gridTemplateColumns: `repeat(${3 + (hasSiteBucket ? 1 : 0) + (uploadedSite ? 0 : 1)}, minmax(0, 1fr))` }}
          >
            <TabsTrigger value="overview">{t("Overview")}</TabsTrigger>
            {!uploadedSite && (
              <TabsTrigger value="environment" className="gap-1.5">
                {t("Environment")}
                {/* the tab says so when something is empty or unsaved, whichever tab is open */}
                {(envStatus.missing.length > 0 || envStatus.dirty) && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />}
              </TabsTrigger>
            )}
            {hasSiteBucket && <TabsTrigger value="files">{t("Site files")}</TabsTrigger>}
            {!uploadedSite && <TabsTrigger value="logs">{t("Logs")}</TabsTrigger>}
            <TabsTrigger value="deployments">{t("Deployments")}</TabsTrigger>
            <TabsTrigger value="settings">{t("Settings")}</TabsTrigger>
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-6">
            {/* created, never deployed: environment first, then the first deploy */}
            {needsSetup && (
              <AppSetupCard
                application={application}
                detected={detection.data}
                detecting={detection.isLoading}
                env={envStatus}
                onDeploy={handleStart}
                onEditEnv={() => setActiveTab("environment")}
                onEditBuild={() => setActiveTab("settings")}
              />
            )}
            {/* nothing to serve yet: the one thing to do is drop the build here */}
            {uploadedSite && !hasSiteFiles && (
              <Card className="bg-gradient-card border-border/50">
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <Upload className="h-5 w-5 text-primary" />
                    <span>{t("Upload files")}</span>
                  </CardTitle>
                  <p className="text-sm text-muted-foreground">
                    {t("Upload the site's build output — the folder with index.html (usually dist/, build/ or out/).")}
                    {" "}
                    {t("It goes live at {domain} as soon as the upload finishes.", { domain: application.domain })}
                  </p>
                </CardHeader>
                <CardContent>
                  <SourcePicker
                    picked={[]}
                    excluded={new Set()}
                    onPick={(entries) => {
                      setDroppedFiles(entries);
                      setReuploadOpen(true);
                    }}
                    onExcludedChange={() => {}}
                  />
                </CardContent>
              </Card>
            )}

            {/* label/value lines in two cards: what visitors get, and what it
                runs on — the whole picture without scrolling */}
            <div className="grid items-start gap-4 md:grid-cols-2">
            <Card className="bg-gradient-card border-border/50">
              <CardHeader className="pb-0">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Globe className="h-4 w-4 text-primary" />
                  {t("Public")}
                </CardTitle>
                <p className="text-xs text-muted-foreground">{t("What visitors get")}</p>
              </CardHeader>
              <CardContent className="pt-2 pb-2">
                <Field label={t("Domain")}>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <span className="font-mono">{application.domain}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => copyToClipboard(application.domain)}
                      aria-label={t("Copy")}
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                    {/* whether the hostname actually answers — RUNNING only ever
                        meant the process started */}
                    {hostname?.live ? (
                      <Badge className="gap-1 bg-success text-success-foreground hover:bg-success/90">
                        <Wifi className="h-3 w-3" />
                        {t("reachable")}
                      </Badge>
                    ) : hostname ? (
                      <>
                        <Badge variant="outline" className="gap-1 border-warning text-warning" title={hostname.error}>
                          <WifiOff className="h-3 w-3" />
                          {hostname.resolves ? t("not serving yet") : t("no DNS")}
                        </Badge>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6"
                          disabled={setupDns.isPending}
                          onClick={() => setupDns.mutate({ id: application.id, force: true })}
                        >
                          {t("Point it here")}
                        </Button>
                      </>
                    ) : null}
                  </div>
                </Field>
                {/* the version visitors are getting */}
                <Field label={t("Last Deployment")}>
                  {lastDeployment ? (
                    <>
                      {new Date(lastDeployment.createdAt).toLocaleString(locale)}
                      {" · "}
                      {deploymentStatusLabel(lastDeployment.status)}
                    </>
                  ) : (
                    t("Never deployed")
                  )}
                  <span className="text-muted-foreground">
                    {" · "}
                    {t("{count} deployments", { count: application.deployments?.length || 0 })}
                  </span>
                </Field>
              </CardContent>
            </Card>

            <Card className="bg-gradient-card border-border/50">
              <CardHeader className="pb-0">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Server className="h-4 w-4 text-primary" />
                  {t("Internal")}
                </CardTitle>
                <p className="text-xs text-muted-foreground">{t("What it runs on — only your team sees this")}</p>
              </CardHeader>
              <CardContent className="pt-2 pb-2">
                {/* where the code comes from says more than a type label twice:
                    an upload redeploys by uploading, a repository by building */}
                <Field label={t("Source")}>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {application.repository ? (
                      <span className="inline-flex min-w-0 items-center gap-1 font-mono text-xs">
                        <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="break-all">{application.repository}</span>
                        <span className="text-muted-foreground">· {application.branch || "main"}</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                        {t("Uploaded files")}
                      </span>
                    )}
                    <Badge variant="secondary" className="text-xs">
                      {isStatic ? t("Static Site") : application.type}
                    </Badge>
                  </div>
                </Field>
                <Field label={t("Server")}>
                  {application.placement ? (
                    <Link
                      to={`/servers/${application.placement.id}`}
                      className="inline-flex flex-wrap items-center justify-end gap-2 hover:text-primary"
                    >
                      <Server className="h-4 w-4 text-muted-foreground" />
                      {application.placement.name}
                      <span className="font-mono text-xs text-muted-foreground">{application.placement.publicIp}</span>
                      {application.placement.tags.map((tag) => (
                        <Badge key={tag} variant="outline" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                    </Link>
                  ) : (
                    // routes and builds refuse to run without one — say it here
                    <span className="text-destructive">
                      {t("No server — assign the organization to one before deploying.")}
                    </span>
                  )}
                </Field>
                {isStatic ? (
                  <Field label={t("Hosting")}>
                    {/* where the files actually are: an R2 bucket once uploaded,
                        the old S3 prefix only for sites deployed before R2 */}
                    {application.staticBucket ? (
                      <>
                        Cloudflare R2{" "}
                        <span className="break-all font-mono text-xs text-muted-foreground">· {application.staticBucket}</span>
                      </>
                    ) : application.staticSiteUrl ? (
                      <span title={application.staticSiteUrl}>{t("Object storage (S3, legacy)")}</span>
                    ) : (
                      <span className="text-muted-foreground">{t("No files uploaded yet")}</span>
                    )}
                  </Field>
                ) : (
                  <Field label={t("Internal port")}>
                    {/* bound to loopback and reached only through the proxy —
                        an admin reading a bare number assumes it is open */}
                    <span
                      className="font-mono"
                      title={t("Bound to loopback on the node. Not reachable from outside; the proxy is what serves this app publicly.")}
                    >
                      {application.port ? `127.0.0.1:${application.port}` : t("Not configured")}
                    </span>
                  </Field>
                )}
                {/* a bucket-served site has no directory on a node; a static
                    site served from disk (imported) does */}
                {(!isStatic || (!application.staticBucket && application.rootPath)) && (
                  <Field label={t("Directory")}>
                    <span className="break-all font-mono text-xs">{application.rootPath || t("Not detected")}</span>
                  </Field>
                )}
                {application.repository && (
                  <Field label={t("Build Command")}>
                    <span className="font-mono text-xs">{application.buildCommand || t("Not configured")}</span>
                  </Field>
                )}
                {!isStatic && (
                  <Field label={t("Start Command")}>
                    <span className="font-mono text-xs">{application.startCommand || t("Not configured")}</span>
                  </Field>
                )}
                {!uploadedSite && (
                  <Field label={t("Environment Variables")}>
                    {/* names only — values can be secrets, and this page is widely viewed */}
                    {application.envVars && Object.keys(application.envVars).length > 0 ? (
                      <span className="break-all font-mono text-xs">{Object.keys(application.envVars).join(", ")}</span>
                    ) : (
                      <span className="text-muted-foreground">{t("No environment variables configured")}</span>
                    )}
                  </Field>
                )}
              </CardContent>
            </Card>
            </div>
          </TabsContent>

          {/* Kept mounted while hidden: switching tabs must not throw away unsaved
              edits, and the checklist on Overview reads its status from here. */}
          {!uploadedSite && (
            <TabsContent value="environment" forceMount className="space-y-6 data-[state=inactive]:hidden">
              <Card className="bg-gradient-card border-border/50">
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <KeyRound className="h-5 w-5 text-primary" />
                    <span>{t("Environment Variables")}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <AppEnvironment application={application} detected={detection.data} onStatus={setEnvStatus} />
                </CardContent>
              </Card>
            </TabsContent>
          )}

          {/* what the static site is serving — only once there is a bucket */}
          {hasSiteBucket && (
            <TabsContent value="files" className="space-y-6">
              <SiteFilesCard appId={application.id} />
            </TabsContent>
          )}

          {/* Logs Tab */}
          <TabsContent value="logs" className="space-y-6">
            <Card className="bg-gradient-card border-border/50">
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Terminal className="h-5 w-5 text-primary" />
                  <span>{t("App Logs")}</span>
                  {liveLogs && !live.error && (
                    <Badge variant="outline" className="gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                      {t("Live")}
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Log Controls */}
                <div className="flex items-center space-x-4">
                  {!isStatic && <div className="space-y-2">
                    <label className="text-sm font-medium">{t("Log Type")}</label>
                    <Select value={selectedLogType} onValueChange={setSelectedLogType}>
                      <SelectTrigger className="w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="combined">{LOG_TYPE_LABELS.combined}</SelectItem>
                        <SelectItem value="out">{LOG_TYPE_LABELS.out}</SelectItem>
                        <SelectItem value="error">{LOG_TYPE_LABELS.error}</SelectItem>
                        <SelectItem value="build">{LOG_TYPE_LABELS.build}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>}
                  
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t("Lines")}</label>
                    <Select value={logLines.toString()} onValueChange={(value) => setLogLines(parseInt(value))}>
                      <SelectTrigger className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="50">{t("{n} lines", { n: 50 })}</SelectItem>
                        <SelectItem value="100">{t("{n} lines", { n: 100 })}</SelectItem>
                        <SelectItem value="200">{t("{n} lines", { n: 200 })}</SelectItem>
                        <SelectItem value="500">{t("{n} lines", { n: 500 })}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div className="flex items-center space-x-2">
                    <Button
                      variant="outline"
                      onClick={fetchLogs}
                      disabled={logsLoading}
                    >
                      <RefreshCw className={`h-4 w-4 mr-2 ${logsLoading ? "animate-spin" : ""}`} />
                      {t("Refresh")}
                    </Button>
                    
                    <Button
                      variant="outline"
                      onClick={() => setShowRawLogs(!showRawLogs)}
                    >
                      {showRawLogs ? <EyeOff className="h-4 w-4 mr-2" /> : <Eye className="h-4 w-4 mr-2" />}
                      {showRawLogs ? t('Formatted') : t('Raw')}
                    </Button>
                    
                    <Button
                      variant="outline"
                      onClick={() => copyToClipboard(stripAnsi(shownLogs || ''))}
                    >
                      <Copy className="h-4 w-4 mr-2" />
                      {t("Copy")}
                    </Button>
                    
                    <Button variant="outline">
                      <Download className="h-4 w-4 mr-2" />
                      {t("Download")}
                    </Button>
                  </div>
                </div>

                {/* Log Display */}
                <div className="border rounded-md">
                  <ScrollArea className="h-96">
                    <div className="p-4">
                      {shownLogs ? (
                        <pre className="text-sm font-mono whitespace-pre-wrap">
                          {showRawLogs
                            ? stripAnsi(shownLogs)
                            : logSegments.map((segment, i) => (
                                <span key={i} className={segment.className}>{segment.text}</span>
                              ))}
                          <span ref={logsEndRef} />
                        </pre>
                      ) : (
                        <div className="text-center text-muted-foreground py-8">
                          <Terminal className="h-8 w-8 mx-auto mb-2" />
                          <p>{t("No logs available for {type}", { type: LOG_TYPE_LABELS[logType] ?? logType })}</p>
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
            <ReleasesCard appId={application.id} isStatic={isStatic} />
            <DeploymentHistory application={application} />
          </TabsContent>

          {/* Settings Tab */}
          <TabsContent value="settings" className="space-y-6">
            {/* an uploaded site has no build settings — only the danger zone */}
            {!uploadedSite && (
              <Card className="bg-gradient-card border-border/50">
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <Settings className="h-5 w-5 text-primary" />
                    <span>{t("App Settings")}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  <ApplicationSettingsForm application={application} detected={detection.data} />
                </CardContent>
              </Card>
            )}
            <DangerZoneCard application={application} />
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
                <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={executeAction}
                  className={dialogContent.variant === 'destructive' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''}
                  disabled={startApp.isPending || stopApp.isPending || restartApp.isPending}
                >
                  {startApp.isPending || stopApp.isPending || restartApp.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      {t("Processing...")}
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
  /** what the code implies — shown as each empty field's default */
  detected?: DetectedProject | null;
}

const settingsOf = (application: Application) => ({
  installCommand: application?.installCommand || '',
  buildCommand: application?.buildCommand || '',
  preDeployCommand: application?.preDeployCommand || '',
  startCommand: application?.startCommand || '',
  port: application?.port?.toString() || '',
});

function ApplicationSettingsForm({ application, detected }: ApplicationSettingsFormProps) {
  const [formData, setFormData] = useState(() => settingsOf(application));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();
  const updateApp = useUpdateApplication();
  const queryClient = useQueryClient();
  const isStatic = application.type === 'STATIC';

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
        // '' is sent on purpose: it clears back to the detected install / no pre-deploy
        installCommand: formData.installCommand,
        buildCommand: formData.buildCommand || undefined,
        preDeployCommand: formData.preDeployCommand,
        startCommand: formData.startCommand || undefined,
        port: formData.port ? parseInt(formData.port) : undefined,
      };

      await updateApp.mutateAsync({ id: application.id, data: updateData });
      
      toast({
        title: t('Success'),
        description: t('App settings updated successfully'),
      });
      
      // Refetch application data
      queryClient.invalidateQueries({ queryKey: ['application', application.id] });
      
    } catch (error) {
      toast({
        title: t('Error'),
        description: t('Failed to update application settings'),
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReset = () => setFormData(settingsOf(application));

  const hasChanges = () => JSON.stringify(formData) !== JSON.stringify(settingsOf(application));

  const detectedHint = (command?: string | null) =>
    command ? t("Empty uses the detected one: {command}", { command }) : t("Empty uses the detected one.");

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Install Command — Node/PHP only; a static upload never installs */}
      {!isStatic && (
        <div className="space-y-2">
          <label className="text-sm font-medium">
            {t("Install Command")}
            <span className="text-muted-foreground ml-1">{t("(optional)")}</span>
          </label>
          <Input
            value={formData.installCommand}
            onChange={(e) => handleInputChange('installCommand', e.target.value)}
            placeholder={detected?.installCommand || "pnpm install --frozen-lockfile"}
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">{detectedHint(detected?.installCommand)}</p>
        </div>
      )}

      {/* Build Command */}
      <div className="space-y-2">
        <label className="text-sm font-medium">
          {t("Build Command")}
          <span className="text-muted-foreground ml-1">{t("(optional)")}</span>
        </label>
        <Input
          value={formData.buildCommand}
          onChange={(e) => handleInputChange('buildCommand', e.target.value)}
          placeholder={detected?.buildCommand || "npm run build"}
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">{detectedHint(detected?.buildCommand)}</p>
      </div>

      {/* Pre-deploy — migrations, after the build and before the release goes live */}
      {!isStatic && (
        <div className="space-y-2">
          <label className="text-sm font-medium">
            {t("Pre-deploy Command")}
            <span className="text-muted-foreground ml-1">{t("(optional)")}</span>
          </label>
          <Input
            value={formData.preDeployCommand}
            onChange={(e) => handleInputChange('preDeployCommand', e.target.value)}
            placeholder={detected?.env.needsDatabase ? "npx prisma migrate deploy" : "npm run migrate"}
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            {t("Runs after the build with the app's environment, before the new release goes live. If it fails, the old release keeps serving — use it for database migrations.")}
          </p>
        </div>
      )}

      {/* a static site is served, not started: no start command, no port */}
      {!isStatic && <>
      {/* Start Command */}
      <div className="space-y-2">
        <label className="text-sm font-medium">
          {t("Start Command")}
          <span className="text-muted-foreground ml-1">{t("(optional)")}</span>
        </label>
        <Input
          value={formData.startCommand}
          onChange={(e) => handleInputChange('startCommand', e.target.value)}
          placeholder={detected?.startCommand || "npm start"}
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">{detectedHint(detected?.startCommand)}</p>
      </div>

      {/* Port */}
      <div className="space-y-2">
        <label className="text-sm font-medium">
          {t("Port")}
          <span className="text-muted-foreground ml-1">{t("(optional)")}</span>
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
          {t("Port number for your application (1-65535)")}
        </p>
      </div>
      </>}

      {/* Action Buttons */}
      <div className="flex items-center justify-between pt-4 border-t">
        <div className="flex items-center space-x-2">
          <Button
            type="button"
            variant="outline"
            onClick={handleReset}
            disabled={!hasChanges() || isSubmitting}
          >
            {t("Reset")}
          </Button>
          {hasChanges() && (
            <Badge variant="secondary" className="text-xs">
              {t("Unsaved changes")}
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
                {t("Saving...")}
              </>
            ) : (
              <>
                <Settings className="h-4 w-4 mr-2" />
                {t("Save Changes")}
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Help Section */}
      {!isStatic && <div className="bg-muted/50 rounded-lg p-4 space-y-3">
        <h4 className="text-sm font-medium">{t("Help & Examples")}</h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div>
            <p className="font-medium mb-1">Node.js</p>
            <p className="text-muted-foreground">{t("Build: {command}", { command: "yarn build" })}</p>
            <p className="text-muted-foreground">{t("Start: {command}", { command: "yarn start" })}</p>
          </div>
          <div>
            <p className="font-medium mb-1">React</p>
            <p className="text-muted-foreground">{t("Build: {command}", { command: "yarn build" })}</p>
            <p className="text-muted-foreground">{t("Start: {command}", { command: "yarn start" })}</p>
          </div>
          <div>
            <p className="font-medium mb-1">Vue.js</p>
            <p className="text-muted-foreground">{t("Build: {command}", { command: "yarn build" })}</p>
            <p className="text-muted-foreground">{t("Start: {command}", { command: "yarn run serve" })}</p>
          </div>
        </div>
      </div>}
    </form>
  );
} 
