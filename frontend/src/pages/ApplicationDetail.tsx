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
  KeyRound,
  MoreHorizontal,
  Rocket,
  Undo2
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { useApplicationStatus, useStartApplication, useStartExistingApplication, useStopApplication, useRestartApplication, useUpdateApplication, useApplicationHostname, useSetupApplicationDns } from "@/hooks/useApplications";
import { useApplicationLogs, useLiveLogs, useBuildLogStatus, useCreateTestBuildLog } from "@/hooks/useLogs";
import { useDeploymentHistory, useReleases } from "@/hooks/useDeployments";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Application, DetectedProject, UpdateApplicationData, UploadEntry, cancelDeployment, getAppDetection, hasBeenDeployed, type Release } from "@/lib/applications";
import { AppSetupCard } from "@/components/AppSetupCard";
import { AppEnvironment, type EnvStatus } from "@/components/AppEnvironment";
import DeploymentHistory, { LiveBuildLog, RestoreDialog, deploymentStatusLabel } from "@/components/DeploymentHistory";
import { ReuploadDialog } from "@/components/ReuploadDialog";
import { SourcePanel } from "@/components/SourcePanel";
import { SiteFilesCard } from "@/components/SiteFilesCard";
import { SourcePicker } from "@/components/SourcePicker";
import { DangerZoneCard } from "@/components/DangerZoneCard";
import { AppStorageCard } from "@/components/AppStorageCard";
import { locale, t } from "@/lib/i18n";
import { isSuperAdmin } from "@/lib/auth";
import { testDatabaseUrl } from "@/lib/databases";
import { AppDatabasesTab } from "@/components/AppDatabasesTab";
import { AppDomainsCard } from "@/components/AppDomainsCard";
import { DomainExpiryBadge } from "@/components/DomainExpiryBadge";
import { RepointDialog } from "@/components/RepointDialog";
import { parseDatabaseUrl } from "@/lib/env";
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

/** A deploy's steps as its deployment row reports them. */
const DEPLOY_PHASES = [
  { status: 'PENDING', label: t("Queued") },
  { status: 'BUILDING', label: t("Building") },
  { status: 'DEPLOYING', label: t("Going live") },
];

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
  // only Stop asks first: a deploy replaces nothing until it works, and can be cancelled
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmRepoint, setConfirmRepoint] = useState(false);

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
  // pm2 apps and the panel's own unit apps (not PHP/static) stream live, only
  // while the Logs tab is open; the rest poll
  const hasProcess = application?.runtime === 'PM2' || (!application?.runtime && application?.type !== 'PHP' && application?.type !== 'STATIC');
  const liveLogs = !!application && hasProcess && logType !== 'build';
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
  // The deployment history polls itself while a deploy runs (the same query the
  // Deployments tab shows — shared, no extra requests). The app row only polls
  // once it reads DEPLOYING, and a cached ERROR from the last deploy never
  // does — so the history is what says a deploy is running, and when it ends
  // the app row is fetched again for its new status.
  const { data: history } = useDeploymentHistory(id!);
  // kept builds: "Undo last deploy" goes back to the one before what serves
  const { data: releaseData } = useReleases(id!);
  const [undoTo, setUndoTo] = useState<Release | null>(null);
  const newestDeploy = history?.data?.[0];
  const deployInFlight = ['PENDING', 'BUILDING', 'DEPLOYING'].includes(newestDeploy?.status ?? '');
  const queryClient = useQueryClient();
  // stopping a running deploy: confirmed first, then the history shows it end as CANCELLED
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancelDeploy = useMutation({
    mutationFn: () => cancelDeployment(id!),
    onSuccess: () => {
      toast({ title: t("Cancelling the deployment…") });
      void queryClient.invalidateQueries({ queryKey: ['deployments', id] });
    },
    onError: (error: Error) => toast({ variant: "destructive", title: t("Could not cancel the deployment"), description: error.message }),
  });
  useEffect(() => {
    if (newestDeploy && !deployInFlight) void queryClient.invalidateQueries({ queryKey: ['application', id] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newestDeploy?.id, deployInFlight]);
  // A deploy watched to its end — history settled AND the app row left
  // DEPLOYING (the backend writes SUCCESS before the app row and the release):
  // soft-reload everything this page shows about the app, so the buttons,
  // releases, files and hostname follow without a page reload.
  const appDeploying = deployInFlight || application?.status === 'DEPLOYING' || application?.status === 'BUILDING';
  const sawDeploy = useRef(false);
  useEffect(() => {
    if (appDeploying) sawDeploy.current = true;
    else if (sawDeploy.current) {
      sawDeploy.current = false;
      // app-scoped keys all carry the id second: ['application', id], ['releases', id], ...
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[1] === id });
    }
  }, [appDeploying, id, queryClient]);
  // the Environment tab's form, for the setup checklist on the Overview tab
  const [envStatus, setEnvStatus] = useState<EnvStatus>({ missing: [], warnings: [], dirty: false });
  // Before the first deploy, the saved DATABASE_URL tried from the app's node:
  // a login that fails or a host it cannot reach is said on the checklist, not
  // found in the logs of a crashed app. Re-run whenever the app is saved.
  const savedDbUrl = application?.envVars?.DATABASE_URL ?? '';
  const dbCheck = useQuery({
    // not under ['application', id]: the status poll invalidates that every 2s during a deploy
    queryKey: ['db-check', id, application?.updatedAt],
    queryFn: () => testDatabaseUrl(id!, 'DATABASE_URL'),
    enabled: needsSetup && !!parseDatabaseUrl(savedDbUrl).engine,
    staleTime: 60_000,
    retry: false,
  });
  // the Environment tab's save: a deploy uses the saved env, so unsaved edits go first
  const envSave = useRef<(() => Promise<boolean>) | null>(null);
  const connectDb = useRef<(() => void) | null>(null);
  const [savingForDeploy, setSavingForDeploy] = useState(false);
  const deploy = async () => {
    if (envStatus.dirty) {
      setSavingForDeploy(true);
      const saved = await envSave.current?.();
      setSavingForDeploy(false);
      if (!saved) return;
    }
    startApp.mutate(id!);
  };
  const starting = savingForDeploy || startApp.isPending;

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
  // the last attempt failed — whether or not the app is still up on the release before it
  const failureReason =
    lastDeployment?.status === 'FAILED'
      ? stripAnsi(lastDeployment.deployLogs || lastDeployment.buildLogs?.trim().split('\n').slice(-3).join('\n') || '') || undefined
      : undefined;
  // A deploy runs in the background after /start answers, so the request being
  // pending says little: the app's status and its newest deployment are the
  // truth. The status poll (useApplicationStatus) flips this back when it ends.
  const deploying =
    startApp.isPending ||
    deployInFlight ||
    application.status === 'DEPLOYING' ||
    application.status === 'BUILDING' ||
    ['PENDING', 'BUILDING', 'DEPLOYING'].includes(lastDeployment?.status ?? '');

  const deployed = hasBeenDeployed(application);
  // where the running deploy is, from its row's status (PENDING → BUILDING → DEPLOYING)
  const phaseIndex = Math.max(0, DEPLOY_PHASES.findIndex((phase) => phase.status === (newestDeploy?.status ?? lastDeployment?.status)));
  const siteLive = published && !!hostname?.live;
  const canStop = !isStatic && application.status === 'RUNNING';
  // an uploaded site redeploys by uploading, from its own button
  const canRedeploy = deployed && !uploadedSite;
  // newest first, so the next READY one after the serving one is the previous version
  const releases = releaseData?.releases ?? [];
  const servingAt = releases.findIndex((release) => release.id === releaseData?.activeReleaseId);
  const previousRelease = servingAt < 0 ? undefined : releases.slice(servingAt + 1).find((release) => release.status === 'READY');

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
        </div>

        {/* the tabs, with a control panel beside them: what the app is doing
            and what can be done to it, always in view instead of stacked on top */}
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <aside className="space-y-4 lg:sticky lg:top-4 lg:order-last">
        <Card className={`bg-gradient-card ${failureReason ? "border-destructive/40" : "border-border/50"}`}>
          <CardContent className="space-y-4 p-4">
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 shrink-0">
                {siteLive ? <CheckCircle className="h-5 w-5 text-green-500" /> : getStatusIcon(application.status)}
              </div>
              <div className="min-w-0">
                <h3 className="font-semibold">
                  {siteLive ? t("Live and serving") : failureReason ? t("Deploy failed") : STATUS_LABELS[application.status] ?? application.status}
                </h3>
                <p className="break-words text-sm text-muted-foreground">
                  {uploadedSite && !hasSiteFiles ? t("No files yet — upload the site's build output (a folder with index.html).") :
                   siteLive ? (
                     <a href={`https://${application.domain}`} target="_blank" rel="noreferrer" className="break-all font-mono text-xs text-foreground hover:text-primary hover:underline">
                       https://{application.domain}
                     </a>
                   ) :
                   published ? t("Up — waiting for {domain} to answer. DNS and the certificate can take a few minutes.", { domain: application.domain }) :
                   application.status === 'STOPPED' ? t("Stopped — nothing is serving.") :
                   failureReason ? t("Whatever was serving before keeps serving.") :
                   t("Not serving.")}
                </p>
              </div>
            </div>


          {/* no refresh button: the data refetches whenever the tab regains
              focus, and polls while a deploy runs */}
          <div className="flex flex-col gap-2 [&>button]:w-full [&>a]:w-full">
            {siteLive && (
              <Button asChild variant="outline">
                <a href={`https://${application.domain}`} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4 mr-2" />
                  {t("Visit site")}
                </a>
              </Button>
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

            {/* at most one safe primary action. While a deploy runs its progress
                is in the banner above, so only Cancel here; before the first
                deploy the setup card owns the button; an uploaded site redeploys
                by upload. Once deployed, Redeploy rebuilds what is live — so it
                sits in the menu, not one stray click away */}
            {deploying ? (
              <Button
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={cancelDeploy.isPending}
                onClick={() => setConfirmCancel(true)}
              >
                <Square className="h-4 w-4 mr-2" />
                {t("Cancel deploy")}
              </Button>
            ) : needsSetup || uploadedSite ? null : !deployed ? (
              <Button onClick={deploy} disabled={starting} className="bg-gradient-primary">
                {starting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Rocket className="h-4 w-4 mr-2" />}
                {t("Deploy")}
              </Button>
            ) : !isStatic && application.status !== 'RUNNING' ? (
              // stopped: bring the built release back — nothing is rebuilt
              <Button onClick={() => startExistingApp.mutate(application.id)} disabled={startExistingApp.isPending} className="bg-gradient-primary">
                {startExistingApp.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
                {t("Start")}
              </Button>
            ) : null}

            {/* the actions that change what is live, one deliberate click further away */}
            {!deploying && (canRedeploy || canStop || !!previousRelease || (uploadedSite && hasSiteFiles)) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">
                    <MoreHorizontal className="h-4 w-4 mr-2" />
                    {t("More actions")}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  {canRedeploy && (
                    <DropdownMenuItem disabled={starting} onClick={deploy} className="items-start">
                      <Rocket className="mr-2 mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        {t("Redeploy")}
                        <span className="block text-xs text-muted-foreground">
                          {published
                            ? t("Builds the latest code. The current release keeps serving until it answers.")
                            : t("Builds the latest code and starts it.")}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  )}
                  {previousRelease && (
                    <DropdownMenuItem onClick={() => setUndoTo(previousRelease)} className="items-start">
                      <Undo2 className="mr-2 mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        {t("Undo last deploy")}
                        <span className="block text-xs text-muted-foreground">
                          {t("Back to the version from {time}. Nothing is rebuilt.", {
                            time: new Date(previousRelease.createdAt).toLocaleString(locale),
                          })}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  )}
                  {uploadedSite && hasSiteFiles && (
                    // points the site back at the files already uploaded — the way back after a failed upload
                    <DropdownMenuItem disabled={starting} onClick={() => startApp.mutate(application.id)}>
                      <RotateCcw className="mr-2 h-4 w-4" />
                      {t("Republish current files")}
                    </DropdownMenuItem>
                  )}
                  {canStop && (
                    <>
                      <DropdownMenuItem disabled={restartApp.isPending} onClick={() => restartApp.mutate(application.id)}>
                        <RefreshCw className="mr-2 h-4 w-4" />
                        {t("Restart")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        disabled={stopApp.isPending}
                        onClick={() => setConfirmStop(true)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Square className="mr-2 h-4 w-4" />
                        {t("Stop")}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          </CardContent>
        </Card>
        {/* the branch and what is newer than live — after the first deploy;
            before it the setup card is where deploying happens */}
        {application.repository && !needsSetup && (
          <SourcePanel application={application} onDeploy={deploy} starting={starting} deploying={deploying} />
        )}
        </aside>

        {/* Main Content */}
          {/* the main column: what the app is doing right now (deploy, setup, a
              failure) sits above the tabs, beside the control panel — not across
              the whole page, so the layout does not jump when it comes and goes */}
          <div className="min-w-0 space-y-6">
          {/* Status Banner — a running deploy shows its progress and build log
              here, on every tab; an app never deployed shows what it still needs */}
          {deploying ? (
            <Card className="bg-gradient-card border-primary/40">
              <CardContent className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="flex items-center gap-2 text-lg font-semibold">
                    <Loader2 className="h-5 w-5 animate-spin text-primary" />
                    {deployed ? t("Redeploying…") : t("Deploying…")}
                  </h3>
                  <ol className="flex flex-wrap items-center gap-2 text-sm">
                    {DEPLOY_PHASES.map((phase, index) => (
                      <li
                        key={phase.status}
                        className={`flex items-center gap-1.5 ${
                          index < phaseIndex ? "text-primary" : index === phaseIndex ? "font-medium" : "text-muted-foreground/60"
                        }`}
                      >
                        {index < phaseIndex ? <CheckCircle className="h-4 w-4" /> : index === phaseIndex ? <Loader2 className="h-4 w-4 animate-spin" /> : <span className="h-4 w-4 rounded-full border" />}
                        {phase.label}
                        {index < DEPLOY_PHASES.length - 1 && <span className="text-muted-foreground/50">→</span>}
                      </li>
                    ))}
                  </ol>
                </div>
                {published && (
                  <p className="mt-1 text-xs text-muted-foreground">{t("The current release keeps serving until the new one answers.")}</p>
                )}
                {!uploadedSite && <LiveBuildLog appId={application.id} />}
              </CardContent>
            </Card>
          ) : needsSetup ? (
            <AppSetupCard
              application={application}
              detected={detection.data}
              detecting={detection.isLoading}
              env={envStatus}
              dbCheck={dbCheck.isFetching ? "pending" : dbCheck.data ?? null}
              failure={failureReason}
              starting={starting}
              onDeploy={deploy}
              onEditEnv={() => setActiveTab("environment")}
              onEditBuild={() => setActiveTab("settings")}
            />
          ) : failureReason ? (
            // why it failed needs room to be read — the main column, not the side panel
            <Card className="bg-gradient-card border-destructive/40">
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="flex items-center gap-2 text-lg font-semibold text-destructive">
                      <AlertCircle className="h-5 w-5" />
                      {t("The last deploy failed")}
                    </h3>
                    <p className="text-sm text-muted-foreground">{t("Whatever was serving before keeps serving.")}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button onClick={deploy} disabled={starting} className="bg-gradient-primary">
                      {starting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-2" />}
                      {t("Retry deploy")}
                    </Button>
                    {!uploadedSite && (
                      <Button variant="outline" onClick={() => setActiveTab("environment")}>
                        {t("Edit environment")}
                      </Button>
                    )}
                    <Button variant="ghost" onClick={() => setActiveTab("deployments")}>
                      {t("Full log")}
                    </Button>
                  </div>
                </div>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs text-destructive">
                  {failureReason}
                </pre>
              </CardContent>
            </Card>
          ) : null}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList
            className="grid w-full"
            // overview, deployments, domains, settings, plus files / environment + logs / database when they apply
            style={{ gridTemplateColumns: `repeat(${4 + (hasSiteBucket ? 1 : 0) + (uploadedSite ? 0 : 2) + (isStatic ? 0 : 1)}, minmax(0, 1fr))` }}
          >
            {/* what is live, then where it is reached, then what it is made of */}
            <TabsTrigger value="overview">{t("Overview")}</TabsTrigger>
            <TabsTrigger value="deployments">{t("Deployments")}</TabsTrigger>
            {!uploadedSite && <TabsTrigger value="logs">{t("Logs")}</TabsTrigger>}
            <TabsTrigger value="domains">{t("Domains")}</TabsTrigger>
            {!isStatic && <TabsTrigger value="database">{t("Database")}</TabsTrigger>}
            {!uploadedSite && (
              <TabsTrigger value="environment" className="gap-1.5">
                {t("Environment")}
                {/* the tab says so when something is empty or unsaved, whichever tab is open */}
                {(envStatus.missing.length > 0 || envStatus.dirty) && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />}
              </TabsTrigger>
            )}
            {hasSiteBucket && <TabsTrigger value="files">{t("Site files")}</TabsTrigger>}
            <TabsTrigger value="settings">{t("Settings")}</TabsTrigger>
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-6">
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
                    <DomainExpiryBadge domain={application.parentDomain} />
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
                          // overwrites whatever the record points at — asked first, never one click
                          onClick={() => setConfirmRepoint(true)}
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
                      <>
                        <span className="inline-flex min-w-0 items-center gap-1 font-mono text-xs">
                          <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="break-all">{application.repository}</span>
                          <span className="text-muted-foreground">· {application.branch || "main"}</span>
                        </span>
                      </>
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
                  {application.placement && isSuperAdmin() ? (
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
                  ) : application.placement ? (
                    // the server pages are superadmin-only: for anyone else, just its name
                    <span className="inline-flex items-center gap-2">
                      <Server className="h-4 w-4 text-muted-foreground" />
                      {application.placement.name}
                    </span>
                  ) : (
                    // routes and builds refuse to run without one — say it here
                    <span className="text-destructive">
                      {t("No server — assign the organization to one before deploying.")}
                    </span>
                  )}
                </Field>
                {isStatic && (
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

          <TabsContent value="domains">
            <AppDomainsCard application={application} />
          </TabsContent>

          {!isStatic && (
            <TabsContent value="database">
              <AppDatabasesTab
                applicationId={application.id}
                applicationName={application.name}
                // the dialog lives in the (always mounted) env form, so it opens right here
                onConnect={() => (connectDb.current ? connectDb.current() : setActiveTab("environment"))}
              />
            </TabsContent>
          )}

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
                  <AppEnvironment application={application} detected={detection.data} onStatus={setEnvStatus} saveRef={envSave} connectDbRef={connectDb} />
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
            {/* a static site keeps its files in R2, not on a node; measured (du
                over SSH) only while Settings is open — TabsContent unmounts */}
            {!isStatic && <AppStorageCard appId={application.id} deploying={deploying} />}
            <DangerZoneCard application={application} />
          </TabsContent>
        </Tabs>
          </div>
        </div>

        <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("Cancel this deployment?")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("The build stops and nothing new goes live. Whatever was serving before keeps serving.")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("Keep deploying")}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => cancelDeploy.mutate()}
              >
                {t("Cancel deployment")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <RestoreDialog appId={application.id} isStatic={isStatic} release={undoTo} onClose={() => setUndoTo(null)} />


        <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("Stop App")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("Are you sure you want to stop \"{name}\"? This will shut down the running application.", { name: application.name })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => stopApp.mutate(application.id)}
              >
                {t("Stop App")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {confirmRepoint && (
          <RepointDialog
            application={application}
            onClose={() => setConfirmRepoint(false)}
            onConfirm={() => {
              setupDns.mutate({ id: application.id, force: true });
              setConfirmRepoint(false);
            }}
          />
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

      {/* Pre-deploy — migrations, before the build and before the release goes live */}
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
            {t("Runs before the build with the app's environment, so the build can use the tables. If it fails, the old release keeps serving — use it for database migrations.")}
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
