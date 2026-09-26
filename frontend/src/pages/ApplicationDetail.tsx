import { useState, useEffect, useRef, useMemo } from "react";
import { StackExecCard } from "@/components/StackExecCard";
import { createPortal } from "react-dom";
import { useParams, useNavigate, Link, Navigate } from "react-router-dom";
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
  Power,
  Zap,
  Wifi,
  WifiOff,
  Upload,
  KeyRound,
  MoreVertical,
  Rocket,
  Undo2,
  Pencil,
  X
} from "lucide-react";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { Application, DetectedProject, UpdateApplicationData, UploadEntry, cancelDeployment, failedMigrationOf, getAppDetection, getStackServices, getAppFolder, getApplication, hasBeenDeployed, hostList, hostsOf, setApplicationDisabled, runtimeLabel, startPm2Build, type Release, type StartOptions } from "@/lib/applications";
import { AppSetupCard, DeployFailureFixes } from "@/components/AppSetupCard";
import { useDeployConfirm } from "@/components/DeployConfirmDialog";
import { ComposePreview, ComposeServiceSelect } from "@/components/ComposePreview";
import { RestartDialog } from "@/components/RestartDialog";
import { AppEnvironment, type EnvStatus } from "@/components/AppEnvironment";
import DeploymentHistory, { RestoreDialog, deploymentStatusLabel } from "@/components/DeploymentHistory";
import { DeployProgress } from "@/components/DeployProgress";
import { ReuploadDialog } from "@/components/ReuploadDialog";
import { SourcePanel } from "@/components/SourcePanel";
import { appStatus, getApplicationHealth } from "@/lib/health";
import { SiteFilesCard } from "@/components/SiteFilesCard";
import { SourcePicker } from "@/components/SourcePicker";
import { DangerZoneCard } from "@/components/DangerZoneCard";
import { AppStorageCard } from "@/components/AppStorageCard";
import { locale, t } from "@/lib/i18n";
import { isAdmin, isSuperAdmin } from "@/lib/auth";
import { DnsFixCard } from "@/components/DnsFixCard";
import { testDatabaseUrl } from "@/lib/databases";
import { AppDatabasesTab } from "@/components/AppDatabasesTab";
import { RoutingCard } from "@/components/RoutingCard";
import { Checkbox } from "@/components/ui/checkbox";
import { ServerEnv } from "@/components/ServerEnv";
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
// functions, so t() reads the dictionary at render, not at import
const STATUS_LABELS: Record<string, string> = {
  RUNNING: t("Running"),
  STOPPED: t("Stopped"),
  ERROR: t("Error"),
  DEPLOYING: t("Deploying"),
  BUILDING: t("Building"),
};

/** A deploy's steps as its deployment row reports them. */
const LOG_TYPE_LABELS: Record<string, string> = {
  combined: t("Combined Logs"),
  out: t("Output Logs"),
  error: t("Error Logs"),
  build: t("Build Logs"),
};

/** Label left, value right — every line of the overview card. */
export const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-start justify-between gap-3 border-b border-border/60 py-2 text-sm">
    <span className="shrink-0 text-muted-foreground">{label}</span>
    <div className="min-w-0 text-right">{children}</div>
  </div>
);

/** A stack's services, one line each — the Deployment card's; picking one is on the settings form (ComposePreview). */
const StackServicesField = ({ applicationId }: { applicationId: string }) => {
  const { data, error } = useQuery({
    // the settings form's query: one read serves both
    queryKey: ["application", applicationId, "compose-services"],
    queryFn: () => getStackServices(applicationId),
    retry: false,
    staleTime: 60_000,
  });
  return (
    <div className="space-y-1.5 border-b border-border/60 py-2 text-sm">
      <span className="text-muted-foreground">{t("Services")}</span>
      {error ? (
        <p className="break-all text-xs text-destructive">{(error as Error).message}</p>
      ) : !data ? (
        <p className="text-xs text-muted-foreground">{t("Reading the compose files…")}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border/60">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th className="px-2 py-1 font-medium">{t("Service")}</th>
                <th className="px-2 py-1 font-medium">{t("Image")}</th>
                <th className="px-2 py-1 font-medium">{t("Port")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60 font-mono">
              {data.map((service) => (
                <tr key={service.name}>
                  <td className="whitespace-nowrap px-2 py-1">{service.name}</td>
                  <td className="break-all px-2 py-1 text-muted-foreground">
                    {service.build ? <span className="font-sans">{t("built from the repository")}</span> : service.image}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1">{service.ports.join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

interface ApplicationLogs {
  build?: string;
  combined?: string;
  out?: string;
  error?: string;
}

/**
 * /services/:id — a service lives on its app's page now: go there with the
 * app picked. An app without a project (none should be left once the startup
 * backfill ran) keeps a page of its own.
 */
export default function ApplicationDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: app, isLoading } = useQuery({ queryKey: ['application', id], queryFn: () => getApplication(id!) });
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }
  if (app?.sourceId) return <Navigate to={`/apps/${app.sourceId}?service=${app.id}`} replace />;
  return <AppWorkspace appId={id!} />;
}

/**
 * One app: its state and actions beside its tabs. On its project's page
 * (`embedded`) the project's header stands above it instead of its own.
 * `inProject`: the project shows the source and the databases (they are the
 * whole project's — its apps share them) — this app has no tabs or source panel
 * for them. Its own deploys are a section of its page.
 */
export function AppWorkspace({
  appId,
  embedded = false,
  inProject = false,
  panelSlot,
}: {
  appId: string;
  embedded?: boolean;
  inProject?: boolean;
  /** in a project, beside the app's breadcrumb: its actions render there, without the status card */
  panelSlot?: HTMLElement | null;
}) {
  const id = appId;
  const toPanel = (node: React.ReactNode) => (panelSlot ? createPortal(node, panelSlot) : node);
  const navigate = useNavigate();
  const { toast } = useToast();

  // State
  const [activeTab, setTab] = useState("overview");
  // in a project the app is one page of sections, not tabs (the project has the tabs): "go to" scrolls there
  const stacked = inProject;
  // stacked: env and build are shown read-only, edited in dialogs
  const [envOpen, setEnvOpen] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);
  const setActiveTab = (tab: string) => {
    if (stacked && tab === "environment") setEnvOpen(true);
    else if (stacked && tab === "build") setBuildOpen(true);
    else if (stacked) document.getElementById(`app-section-${tab}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    else setTab(tab);
  };
  // each section of the page: always rendered when stacked — a cell of the page's two-column grid
  // (`wide`: both columns), reachable by its id
  const section = (name: string, wide = true) =>
    stacked
      ? { forceMount: true as const, id: `app-section-${name}`, className: `mt-0 scroll-mt-4 space-y-6 ${wide ? "md:col-span-2" : ""}` }
      : { className: "space-y-6" };
  const [selectedLogType, setSelectedLogType] = useState("combined");
  const [logLines, setLogLines] = useState(100);
  const [showRawLogs, setShowRawLogs] = useState(false);
  const [logs, setLogs] = useState<ApplicationLogs>({});
  const [reuploadOpen, setReuploadOpen] = useState(false);
  // files dropped on the empty-site card, handed to the upload dialog
  const [droppedFiles, setDroppedFiles] = useState<UploadEntry[]>();
  // only Stop asks first: a deploy replaces nothing until it works, and can be cancelled
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  // the in-place build of an imported pm2 app: asked first, with a tick — the site can err while it builds
  const [confirmPm2Build, setConfirmPm2Build] = useState(false);
  const [pm2Consent, setPm2Consent] = useState(false);
  const pm2Build = useMutation({
    mutationFn: (consent: boolean) => startPm2Build(id!, consent),
    onSuccess: () => {
      toast({ title: t("Building on the server"), description: t("Follow it on the Deployments tab.") });
      void queryClient.invalidateQueries({ queryKey: ['application', id] });
      void queryClient.invalidateQueries({ queryKey: ['deployments'] });
      setActiveTab("deployments");
    },
    onError: (error: Error) => toast({ variant: "destructive", title: t("Could not start the build"), description: error.message }),
  });
  // the env names on the overview: a few, or all of them
  const [envExpanded, setEnvExpanded] = useState(false);
  // which of its names "Point it here" was asked for
  const [repointHost, setRepointHost] = useState<string | null>(null);

  // API hooks
  const { application, isLoading, error } = useApplicationStatus(id!);
  // each of its names checked on its own; polls until every one answers, then settles
  const { data: checks } = useApplicationHostname(id!, true);
  // the same uptime checks the apps list colours its dot from
  const { data: healthById } = useQuery({
    queryKey: ['applications', 'health', [id]],
    queryFn: () => getApplicationHealth([id!]),
    refetchInterval: 60_000,
  });
  const setupDns = useSetupApplicationDns();
  // switched off in the panel (not monitored, listed last) — back on from here
  const toggleDisabled = useMutation({
    mutationFn: (disabled: boolean) => setApplicationDisabled(id!, disabled),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['application', id] });
      void queryClient.invalidateQueries({ queryKey: ['applications'] });
    },
  });
  const startApp = useStartApplication();
  const startExistingApp = useStartExistingApplication();
  const stopApp = useStopApplication();
  const restartApp = useRestartApplication();

  // Logs hooks
  // a static site has no process, so the build log is the only one it has
  const logType = application?.type === 'STATIC' ? 'build' : selectedLogType;
  // pm2 apps and the panel's own unit apps (not PHP/static) stream live, only
  // while the Logs tab is open; the rest poll
  // a compose stack has a process too — the stack itself, whose logs stream
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
  // an imported app (runtime set) is run by whoever set it up — the panel never deploys it
  const needsSetup = canDetect && !application?.runtime && !hasBeenDeployed(application!);
  const detection = useQuery({
    queryKey: ['application', id, 'detect'],
    queryFn: () => getAppDetection(id!),
    enabled: canDetect && (needsSetup || activeTab === 'environment' || activeTab === 'build'),
    staleTime: 5 * 60_000,
    retry: false,
  });
  // an imported app's folder is whatever the sync recorded — ask the server if it
  // is really there. Not under ['application', id]: that is invalidated every 2s while deploying.
  const folder = useQuery({
    queryKey: ['app-folder', id],
    queryFn: () => getAppFolder(id!),
    enabled: !!application?.runtime && !!application?.rootPath,
    staleTime: 60_000,
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
  // the Host card's dialog — opened from the setup checklist's Host step too
  const [hostsOpen, setHostsOpen] = useState(false);
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
  const deployNow = async (options: StartOptions = {}) => {
    if (envStatus.dirty) {
      setSavingForDeploy(true);
      const saved = await envSave.current?.();
      setSavingForDeploy(false);
      if (!saved) return;
    }
    startApp.mutate({ id: id!, ...options });
  };
  // an app with migrations is asked first (migrate on by default)
  const confirmDeploy = useDeployConfirm(application ?? undefined, (options) => void deployNow(options));
  const deploy = async (options: StartOptions = {}) => confirmDeploy.deploy(options);
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
          <h3 className="text-lg font-semibold mb-2">{t("Service Not Found")}</h3>
          <p className="text-muted-foreground mb-4">{t("The service you're looking for doesn't exist.")}</p>
          <Button onClick={() => navigate('/')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t("Back to Services")}
          </Button>
        </div>
      </div>
    );
  }

  const isStatic = application.type === 'STATIC';
  // a static site deployed from an upload: the upload is the deploy — no
  // build, no process, so no start/stop/restart, logs or build settings
  const uploadedSite = isStatic && !application.repository;
  const hasSiteFiles = !!application.staticBucket;
  const hasSiteBucket = isStatic && !!application.staticBucket;
  // an uploaded site never builds, and an imported app is not deployed by us
  const showBuild = !uploadedSite && !application.runtime;
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
      ? stripAnsi(lastDeployment.deployLogs || lastDeployment.buildLogs?.trim().split('\n').slice(-15).join('\n') || '') || undefined
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
  // same verdict as the apps list's dot: the uptime checks win over the stored status
  const overall = appStatus(application.status, healthById?.[application.id], application.disabled);
  // answering now, and either expected to (published) or the checks agree — a
  // sync's ERROR ("no listener on the port") must not call a site that answers dead
  // answers, but the name leads to another server: that is not this app serving.
  // The live DNS check here, else what the last hostname check found.
  // Every name must: one answering from another server, or not at all, is the
  // app not serving there — said by name.
  const hosts = hostsOf(application);
  // a binding's check: its host at its path; a host alone, its first
  const checkOf = (host: string, path?: string) => checks?.find((check) => check.host === host && (path === undefined || (check.path ?? '') === path));
  const allLive = !!checks?.length && checks.every((check) => check.live);
  const strayCheck = checks?.find((check) => check.live && check.pointing?.state === 'elsewhere');
  const elsewhereHost = strayCheck?.host ?? (allLive && healthById?.[application.id]?.pointsElsewhere ? hosts[0] : undefined);
  const elsewhere = strayCheck
    ? strayCheck.pointing!.origin ?? strayCheck.pointing!.addresses.join(', ')
    : allLive
      ? healthById?.[application.id]?.pointsElsewhere
      : undefined;
  // the first name that does not answer — what the card names when it is down
  const failing = checks?.find((check) => !check.live);
  const siteLive = allLive && !elsewhere && (published || overall.tone === 'up');
  // down by the checks (or an ERROR row) — the card must say so, not "Running"
  const down = !siteLive && !failureReason && overall.tone === 'down';
  // start/stop reach a process we deployed, or pm2's; anything else imported
  // was started by someone we cannot ask
  const controllable = !application.runtime || application.runtime === 'PM2';
  const canStop = !isStatic && controllable && application.status === 'RUNNING';
  // an uploaded site redeploys by uploading, from its own button; an imported
  // one is not deployed by the panel at all (a pull or branch switch is not a deploy)
  const canRedeploy = deployed && !uploadedSite && !application.runtime;
  // an imported pm2 app is built where it runs, then restarted by name (pm2DeployService)
  const canPm2Build =
    ((application.runtime === 'PM2' && !!application.processName) || application.runtime === 'CADDY_STATIC') && !!application.rootPath;
  // newest first, so the next READY one after the serving one is the previous version
  const releases = releaseData?.releases ?? [];
  const servingAt = releases.findIndex((release) => release.id === releaseData?.activeReleaseId);
  const previousRelease = servingAt < 0 ? undefined : releases.slice(servingAt + 1).find((release) => release.status === 'READY');
  // what it runs on: runtime, proxy target, hosting, directory — the overview's lines, in either layout
  const runsOn = (
    <>
      <Field label={t("Runtime")}>
        {/* decides how it stops and what removing it touches on the box */}
        <span className="inline-flex flex-wrap items-center justify-end gap-2">
          <Badge variant="outline" className={application.runtime ? "border-warning/50 text-warning" : undefined}>
            {runtimeLabel(application.runtime)}
          </Badge>
          {application.processName && <span className="font-mono text-xs text-muted-foreground">{application.processName}</span>}
        </span>
        {application.configPath && <span className="block break-all font-mono text-xs text-muted-foreground">{application.configPath}</span>}
      </Field>
      {/* where Caddy sends the traffic — loopback on the node, never public */}
      {application.port && (
        <Field label={t("Proxy target")}>
          <span className="font-mono text-xs">127.0.0.1:{application.port}</span>
          {/* the sync's ERROR for a proxy means exactly this */}
          {application.runtime === "CADDY_PROXY" && application.status === "ERROR" && (
            <span className="mt-0.5 flex items-center justify-end gap-1 text-xs text-destructive" title={t("Nothing was listening on this port at the last sync")}>
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {t("Port not listening")}
            </span>
          )}
        </Field>
      )}
      {isStatic && (
        <Field label={t("Hosting")}>
          {/* where the files are: the R2 bucket once uploaded */}
          {application.staticBucket ? (
            <>
              Cloudflare R2 <span className="break-all font-mono text-xs text-muted-foreground">· {application.staticBucket}</span>
            </>
          ) : (
            <span className="text-muted-foreground">{t("No files uploaded yet")}</span>
          )}
        </Field>
      )}
      {/* a bucket-served site has no directory on a node; a static site served from disk (imported) does */}
      {/* the panel's own app: where it is in the repository — each release is a checkout of it */}
      {!application.runtime && application.repository && (
        <Field label={t("Folder in the repository")}>
          <span className="break-all font-mono text-xs">{application.rootDirectory || t("(repository root)")}</span>
        </Field>
      )}
      {/* the panel's app, any type: the files its deploy writes the env into */}
      {!application.runtime && !application.staticBucket && (
        <Field label={t("Env files")}>
          <span className="break-all font-mono text-xs">{(application.composeEnvFiles?.length ? application.composeEnvFiles : [".env"]).join(", ")}</span>
        </Field>
      )}
      {/* a stack: which files compose reads, all in that folder, and what Caddy proxies to */}
      {application.type === "COMPOSE" && (
        <>
          <Field label={t("Compose files")}>
            <span className="break-all font-mono text-xs">{(application.composeFiles?.length ? application.composeFiles : ["docker-compose.yml"]).join(", ")}</span>
          </Field>
          <Field label={t("Service")}>
            {application.composeService ? (
              <span className="font-mono text-xs">
                {application.composeService}:{application.composePort ?? "—"}
              </span>
            ) : (
              <span className="text-xs text-warning">{t("Not set — pick the service and port Caddy sends traffic to")}</span>
            )}
          </Field>
        </>
      )}
      {/* a folder on the node: an imported app's (a panel app's is its repository folder, above) */}
      {(!isStatic || (!application.staticBucket && application.rootPath)) && (application.runtime || application.rootPath) && (
        <Field label={t("Directory")}>
          <span className="break-all font-mono text-xs">{application.rootPath || t("Not detected")}</span>
          {folder.data?.exists === false && (
            <span className="mt-0.5 flex items-center justify-end gap-1 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {t("Not on the server")}
            </span>
          )}
        </Field>
      )}
    </>
  );
  // how it is built and run
  const commands = application.type === "COMPOSE" ? (
    // a stack has no build or start command: `compose up --build` on these files is both
    <>
      <Field label={t("Compose files")}>
        <span className="break-all font-mono text-xs">{(application.composeFiles?.length ? application.composeFiles : ["docker-compose.yml"]).join(", ")}</span>
      </Field>
      <Field label={t("Service")}>
        {application.composeService ? (
          <span className="font-mono text-xs">{application.composeService}:{application.composePort ?? "—"}</span>
        ) : (
          <span className="text-xs text-warning">{t("Not set — pick the service and port Caddy sends traffic to")}</span>
        )}
      </Field>
      <StackServicesField applicationId={application.id} />
    </>
  ) : (
    <>
      {application.repository && (
        <Field label={t("Build Command")}>
          <span className="font-mono text-xs">{application.buildCommand || t("Not configured")}</span>
        </Field>
      )}
      {!isStatic && (
        <Field label={t("Start Command")}>
          {application.runtime === "PM2" && application.processName ? (
            // pm2 keeps the command: it is started and restarted by its name, which is what Restart here runs
            <>
              <span className="font-mono text-xs">pm2 restart {application.processName}</span>
              {application.startCommand && (
                <span className="block break-all font-mono text-[11px] text-muted-foreground" title={t("What pm2 runs")}>
                  {t("runs")}: {application.startCommand}
                </span>
              )}
            </>
          ) : (
            <span className="font-mono text-xs">{application.startCommand || t("Not configured")}</span>
          )}
        </Field>
      )}
    </>
  );
  // in a project, beside its cards: what it is, read-only — its hosts, type, and what it runs on
  const summaryCard = (
    <Card className="bg-gradient-card border-border/50">
      <CardHeader className="pb-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Info className="h-4 w-4 text-primary" />
          {t("Summary")}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-2 pb-2">
        <Field label={t("Host")}>
          {application.domains.map((d) => (
            <a
              key={`${d.host}${d.path ?? ""}`}
              href={`https://${d.host}${d.path ? d.path.replace(/\*+$/, "") : ""}`}
              target="_blank"
              rel="noreferrer"
              className="block break-all font-mono text-xs hover:text-primary"
            >
              {d.host}
              {d.path && <span className="text-muted-foreground">{d.path}</span>}
            </a>
          ))}
        </Field>
        <Field label={t("Type")}>
          <Badge variant="secondary" className="text-xs">
            {isStatic ? t("Static Site") : application.type}
          </Badge>
        </Field>
        {runsOn}
      </CardContent>
    </Card>
  );
  const dnsFix = elsewhere && (
    <DnsFixCard
      host={elsewhereHost ?? hosts[0] ?? ""}
      pointing={checkOf(elsewhereHost ?? "")?.pointing ?? null}
      dnsManaged={!!checkOf(elsewhereHost ?? "")?.dnsManaged}
      portDead={application.runtime === "CADDY_PROXY" && application.status === "ERROR"}
      port={application.port}
      canManage={isAdmin()}
      pending={setupDns.isPending}
      onRepoint={() => setRepointHost(elsewhereHost ?? hosts[0] ?? null)}
    />
  );

  return (
    <TooltipProvider>
      <div className="space-y-6 animate-fade-in">
        {/* Header — on the project's page, the project's header is it */}
        {!embedded && (
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
                {published && hosts.length === 1 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0" asChild>
                        <a
                          href={`https://${hosts[0]}`}
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
                {t("Service Details & Management")}
              </p>
            </div>
          </div>
        </div>
        )}

        {/* the tabs, with a control panel beside them: what the app is doing
            and what can be done to it, always in view instead of stacked on top */}
        {/* in a project only its actions show, as a row beside the breadcrumb (`panelSlot`) — the
            project's status card says how each app stands — and the page is one column */}
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <aside className="space-y-4 lg:sticky lg:top-4 lg:order-last">
        <Card className={`bg-gradient-card ${failureReason ? "border-destructive/40" : "border-border/50"}`}>
          <CardContent className="space-y-4 p-4">
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 shrink-0">
                {application.disabled ? (
                  <Power className="h-5 w-5 text-muted-foreground" />
                ) : siteLive ? (
                  <CheckCircle className="h-5 w-5 text-green-500" />
                ) : elsewhere ? (
                  <AlertTriangle className="h-5 w-5 text-warning" />
                ) : (
                  getStatusIcon(down ? 'ERROR' : application.status)
                )}
              </div>
              <div className="min-w-0">
                <h3 className="font-semibold">
                  {application.disabled
                    ? t("Disabled")
                    : siteLive
                    ? t("Live and serving")
                    : elsewhere
                      ? t("Active, not connected")
                      : failureReason
                        ? t("Deploy failed")
                        : down
                          ? t("Down")
                          : STATUS_LABELS[application.status] ?? application.status}
                </h3>
                <p className="break-words text-sm text-muted-foreground">
                  {application.disabled ? t("Not monitored — switched off in the panel. Nothing on the server changed.") :
                   uploadedSite && !hasSiteFiles ? t("No files yet — upload the site's build output (a folder with index.html).") :
                   elsewhere ? t("{domain} is answered by another server ({ip}), not this one.", { domain: elsewhereHost ?? hostList(application), ip: elsewhere }) :
                   down ? (failing && !failing.resolves
                     ? t("{domain} has no DNS record, so nobody can reach it.", { domain: failing.host })
                     : t("{domain} does not answer.", { domain: failing?.host ?? hostList(application) })) :
                   siteLive ? (
                     hosts.length === 1 ? (
                       <a href={`https://${hosts[0]}`} target="_blank" rel="noreferrer" className="break-all font-mono text-xs text-foreground hover:text-primary hover:underline">
                         https://{hosts[0]}
                       </a>
                     ) : (
                       // several names, all serving: nothing to single out — only a name in trouble is named here
                       null
                     )
                   ) :
                   published ? t("Up — waiting for {domain} to answer. DNS and the certificate can take a few minutes.", { domain: failing?.host ?? hostList(application) }) :
                   application.status === 'STOPPED' ? t("Stopped — nothing is serving.") :
                   failureReason ? t("Whatever was serving before keeps serving.") :
                   t("Not serving.")}
                </p>
              </div>
            </div>

          {/* no refresh button: the data refetches whenever the tab regains
              focus, and polls while a deploy runs. In a project the actions are
              a row in the page's header (`panelSlot`), the state stays here */}
          {toPanel(
          <div className={panelSlot ? "flex flex-wrap items-center justify-end gap-2" : "flex flex-col gap-2 [&>button]:w-full [&>a]:w-full"}>
            {application.disabled && isAdmin() && (
              <Button variant="outline" disabled={toggleDisabled.isPending} onClick={() => toggleDisabled.mutate(false)}>
                <Power className="h-4 w-4 mr-2" />
                {t("Enable")}
              </Button>
            )}
            {/* several names are each a link above; one button could only pick one */}
            {siteLive && hosts.length === 1 && (
              <Button asChild variant="outline">
                <a href={`https://${hosts[0]}`} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4 mr-2" />
                  {t("Visit site")}
                </a>
              </Button>
            )}
            {!application.repository && !application.runtime && (
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
              // a pm2 build on the server runs to its end — there is no release to fall back to mid-way
              application.runtime ? null : (
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={cancelDeploy.isPending}
                  onClick={() => setConfirmCancel(true)}
                >
                  <Square className="h-4 w-4 mr-2" />
                  {t("Cancel deploy")}
                </Button>
              )
            ) : needsSetup || uploadedSite ? null : !deployed && !application.runtime ? (
              <Button onClick={() => void deploy()} disabled={starting} className="bg-gradient-primary">
                {starting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Rocket className="h-4 w-4 mr-2" />}
                {t("Deploy")}
              </Button>
            ) : !isStatic && controllable && application.status !== 'RUNNING' ? (
              // stopped: bring the built release back — nothing is rebuilt
              <Button onClick={() => startExistingApp.mutate(application.id)} disabled={startExistingApp.isPending} className="bg-gradient-primary">
                {startExistingApp.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
                {t("Start")}
              </Button>
            ) : null}

            {/* the actions that change what is live, one deliberate click further away */}
            {!deploying && (canRedeploy || canPm2Build || canStop || !!previousRelease || (uploadedSite && hasSiteFiles)) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">
                    <MoreVertical className="h-4 w-4 mr-2" />
                    {t("More actions")}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  {canRedeploy && (
                    <DropdownMenuItem disabled={starting} onClick={() => void deploy()} className="items-start">
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
                  {canPm2Build && (
                    <DropdownMenuItem onClick={() => setConfirmPm2Build(true)} className="items-start">
                      <Rocket className="mr-2 mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        {t("Build & restart")}
                        <span className="block text-xs text-muted-foreground">
                          {application.runtime === "PM2"
                            ? t("Install, build and pm2 restart {name} in its folder on the server.", { name: application.processName ?? "" })
                            : t("Install and build in its app folder on the server — the files it serves.")}
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
                      <DropdownMenuItem disabled={restartApp.isPending} onClick={() => setConfirmRestart(true)}>
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
          </div>,
          )}
          </CardContent>
        </Card>
        {/* in a project: what it is, at a glance, beside its cards */}
        {stacked && summaryCard}
        {/* answers from someone else's server: how to make it right, either way round */}
        {dnsFix}
        {/* the branch and what is newer than live — after the first deploy;
            before it the setup card is where deploying happens */}
        {/* the panel asks about the migrations itself: straight to the deploy, not the app's own question again */}
        {application.repository && application.sourceId && !needsSetup && !inProject && (
          <SourcePanel projectId={application.sourceId} onDeploy={(skipFor) => void deployNow(skipFor?.includes(application.id) ? { skipPreDeploy: true } : {})} starting={starting} deploying={deploying} />
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
                <DeployProgress
                  appId={application.id}
                  status={newestDeploy?.status ?? lastDeployment?.status}
                  redeploy={deployed}
                  published={published}
                  // an imported app's build logs onto its deployment row, refetched with the app while it runs
                  logText={application.runtime ? lastDeployment?.deployLogs ?? "" : undefined}
                  showLog={!uploadedSite}
                />
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
              failedMigration={lastDeployment?.status === 'FAILED' ? failedMigrationOf(lastDeployment.buildLogs) : null}
              starting={starting}
              onDeploy={(options) => void deploy(options)}
              onEditHosts={() => setHostsOpen(true)}
              onEditEnv={() => setActiveTab("environment")}
              onEditBuild={() => setActiveTab("build")}
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
                    {/* again the same way: an imported pm2 app builds where it runs, asked first */}
                    <Button onClick={canPm2Build ? () => setConfirmPm2Build(true) : () => void deploy()} disabled={starting} className="bg-gradient-primary">
                      {starting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-2" />}
                      {t("Retry deploy")}
                    </Button>
                    {/* an imported app's env is its .env on the server — nothing to edit here */}
                    {!uploadedSite && !application.runtime && (
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
                <DeployFailureFixes
                  application={application}
                  failure={failureReason}
                  failedMigration={lastDeployment?.status === 'FAILED' ? failedMigrationOf(lastDeployment.buildLogs) : null}
                  starting={starting}
                  onDeploy={(options) => void deploy(options)}
                />
              </CardContent>
            </Card>
          ) : null}
          {/* stacked: one grid for every card of the page — the overview's cards and the sections after them pair up */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className={stacked ? "grid grid-cols-1 items-start gap-4 md:grid-cols-2" : "space-y-6"}>
          {/* in a project: no tabs — its sections are cards down one page */}
          {!stacked && (
          <TabsList
            className="grid w-full"
            // overview, deployments, settings, plus files / environment + logs / database / build when they apply
            style={{ gridTemplateColumns: `repeat(${(inProject ? 2 : 3) + (hasSiteBucket ? 1 : 0) + (uploadedSite ? 0 : inProject ? 1 : 2) + (isStatic || inProject ? 0 : 1) + (showBuild ? 1 : 0)}, minmax(0, 1fr))` }}
          >
            {/* what is live, then where it is reached, then what it is made of */}
            <TabsTrigger value="overview">{t("Overview")}</TabsTrigger>
            {!inProject && <TabsTrigger value="deployments">{t("Deployments")}</TabsTrigger>}
            {!uploadedSite && !inProject && <TabsTrigger value="logs">{t("Logs")}</TabsTrigger>}
            {!isStatic && !inProject && <TabsTrigger value="database">{t("Database")}</TabsTrigger>}
            {!uploadedSite && (
              <TabsTrigger value="environment" className="gap-1.5">
                {t("Environment")}
                {/* the tab says so when something is empty or unsaved, whichever tab is open */}
                {(envStatus.missing.length > 0 || envStatus.dirty) && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />}
              </TabsTrigger>
            )}
            {hasSiteBucket && <TabsTrigger value="files">{t("Site files")}</TabsTrigger>}
            {showBuild && <TabsTrigger value="build">Build</TabsTrigger>}
            <TabsTrigger value="settings">{t("Settings")}</TabsTrigger>
          </TabsList>
          )}

          {/* Overview Tab */}
          <TabsContent value="overview" {...section("overview")} {...(stacked ? { className: "contents" } : {})}>
            {/* nothing to serve yet: the one thing to do is drop the build here */}
            {uploadedSite && !hasSiteFiles && (
              <Card className="bg-gradient-card border-border/50 md:col-span-2">
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <Upload className="h-5 w-5 text-primary" />
                    <span>{t("Upload files")}</span>
                  </CardTitle>
                  <p className="text-sm text-muted-foreground">
                    {t("Upload the site's build output — the folder with index.html (usually dist/, build/ or out/).")}
                    {" "}
                    {t("It goes live at {domain} as soon as the upload finishes.", { domain: hostList(application) })}
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

            {stacked ? (
              // in a project: one card per concern — a read-only summary, its hosts (edited here), how it is built and run —
              // cells of the page's grid, so Deployment sits beside Environment
              <div className="contents">
                {/* bento: Host and Deployment stacked tight down the left, Environment fills the right beside both */}
                <div className="flex flex-col gap-4">
                <RoutingCard
                  application={application}
                  pending={setupDns.isPending}
                  onRepoint={(host) => setRepointHost(host)}
                  editOpen={hostsOpen}
                  onEditOpenChange={setHostsOpen}
                />

                <Card className="bg-gradient-card border-border/50">
                  <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 pb-0">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Rocket className="h-4 w-4 text-primary" />
                      {t("Deployments")}
                    </CardTitle>
                    <span className="flex items-center gap-1">
                      {/* how it is built: the panel's own apps, in a dialog */}
                      {showBuild && (
                        <Button variant="outline" size="sm" onClick={() => setBuildOpen(true)}>
                          <Pencil className="mr-2 h-3.5 w-3.5" />
                          {t("Edit")}
                        </Button>
                      )}
                    </span>
                  </CardHeader>
                  <CardContent className="pt-2 pb-2">
                    {commands}
                    <Field label={t("Last Deployment")}>
                      {(application.deployments ?? []).length === 0 ? (
                        t("Never deployed")
                      ) : (
                        <ul className="space-y-0.5">
                          {(application.deployments ?? []).slice(0, 5).map((d) => (
                            <li key={d.id} className="flex items-center justify-end gap-2 text-xs">
                              <span className="text-muted-foreground">{new Date(d.createdAt).toLocaleString(locale)}</span>
                              <Badge variant={d.status === "FAILED" ? "destructive" : "outline"} className="text-[10px]">
                                {deploymentStatusLabel(d.status)}
                              </Badge>
                            </li>
                          ))}
                        </ul>
                      )}
                    </Field>
                  </CardContent>
                </Card>
                </div>
              </div>
            ) : (
            /* label/value lines in two cards: what visitors get, and what it
               runs on — the whole picture without scrolling */
            <div className="grid items-start gap-4 md:grid-cols-2">
            {/* what visitors get: the hosts it answers on — each checked, added and taken off right here */}
            <RoutingCard
              application={application}
              pending={setupDns.isPending}
              onRepoint={(host) => setRepointHost(host)}
              editOpen={hostsOpen}
              onEditOpenChange={setHostsOpen}
            >
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
            </RoutingCard>

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
                    an upload redeploys by uploading, a repository by building.
                    In a project, source, server and checkout are the project's — its Source tab */}
                {inProject ? (
                  <Field label={t("Type")}>
                    <Badge variant="secondary" className="text-xs">
                      {isStatic ? t("Static Site") : application.type}
                    </Badge>
                  </Field>
                ) : (
                <>
                <Field label={t("Source")}>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {application.repository ? (
                      // two lines: the URL alone (wraps anywhere, never overflows), then branch and type
                      <>
                        <span className="w-full break-all text-right font-mono text-xs">{application.repository}</span>
                        <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
                          <GitBranch className="h-3.5 w-3.5 shrink-0" />
                          {application.branch || "main"}
                        </span>
                      </>
                    ) : application.runtime ? (
                      // imported and not a git checkout we could find: it just lives on the box
                      <span className="inline-flex items-center gap-1">
                        <Server className="h-3.5 w-3.5 text-muted-foreground" />
                        {t("Set up on the server")}
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
                      {t("No server — assign the workspace to one before deploying.")}
                    </span>
                  )}
                </Field>
                </>
                )}
                {runsOn}
                {/* imported: the git checkout its folder sits in — where a pull, a branch switch and a build run */}
                {!inProject && application.runtime && application.checkoutPath && application.checkoutPath !== application.rootPath && (
                  <Field label={t("Checkout")}>
                    <span className="break-all font-mono text-xs">{application.checkoutPath}</span>
                  </Field>
                )}
                {commands}
                {!uploadedSite && (
                  <Field label={t("Environment Variables")}>
                    {/* names only — values can be secrets, and this page is widely viewed */}
                    {application.envVars && Object.keys(application.envVars).length > 0 ? (
                      (() => {
                        const keys = Object.keys(application.envVars);
                        // a long .env is a wall: the first few, the rest on request
                        const FEW = 8;
                        const shown = envExpanded ? keys : keys.slice(0, FEW);
                        return (
                          <span className="break-all font-mono text-xs">
                            {shown.join(", ")}
                            {keys.length > FEW && (
                              <button
                                type="button"
                                className="ml-1.5 font-sans text-primary hover:underline"
                                onClick={() => setEnvExpanded((open) => !open)}
                              >
                                {envExpanded ? t("show less") : t("+{count} more", { count: keys.length - FEW })}
                              </button>
                            )}
                          </span>
                        );
                      })()
                    ) : (
                      <span className="text-muted-foreground">{t("No environment variables configured")}</span>
                    )}
                  </Field>
                )}
              </CardContent>
            </Card>
            </div>
            )}
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
            <TabsContent
              value="environment"
              forceMount
              {...section("environment", false)}
              // stacked: the right column beside Host and Deployment — at least as tall as the two
              className={stacked ? `${section("environment", false).className} md:col-start-2 md:row-start-1 md:self-stretch [&>div]:h-full` : "space-y-6 data-[state=inactive]:hidden"}
            >
              <Card className="bg-gradient-card border-border/50">
                <CardHeader className={stacked ? "flex flex-row items-center justify-between gap-3 space-y-0 pb-0" : undefined}>
                  <CardTitle className={stacked ? "flex items-center gap-2 text-base" : "flex items-center space-x-2"}>
                    <KeyRound className={stacked ? "h-4 w-4 text-primary" : "h-5 w-5 text-primary"} />
                    <span>{stacked ? t("Env") : t("Environment Variables")}</span>
                  </CardTitle>
                  {/* stacked: shown here, edited in a dialog — the panel's own apps only; an imported one's is its .env */}
                  {stacked && !application.runtime && (
                    <Button variant="outline" size="sm" onClick={() => setEnvOpen(true)}>
                      <Pencil className="mr-2 h-3.5 w-3.5" />
                      {t("Edit")}
                      {(envStatus.missing.length > 0 || envStatus.dirty) && <span className="ml-1.5 h-1.5 w-1.5 rounded-full bg-amber-500" />}
                    </Button>
                  )}
                </CardHeader>
                <CardContent className={stacked ? "pt-3" : undefined}>
                  {/* imported: its .env on the server is the truth — shown, not edited */}
                  {application.runtime ? (
                    <ServerEnv env={application.envVars ?? {}} dir={application.rootPath} />
                  ) : stacked ? (
                    <>
                      <ServerEnv env={application.envVars ?? {}} note={t("What the service gets at its next deploy.")} />
                      {/* the form stays mounted while closed: its unsaved edits, the checklist and deploy's save-first live on */}
                      <KeptModal open={envOpen} onClose={() => setEnvOpen(false)} title={t("Env")}>
                        <AppEnvironment application={application} detected={detection.data} onStatus={setEnvStatus} saveRef={envSave} connectDbRef={connectDb} />
                      </KeptModal>
                    </>
                  ) : (
                    <AppEnvironment application={application} detected={detection.data} onStatus={setEnvStatus} saveRef={envSave} connectDbRef={connectDb} />
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          )}

          {/* what the static site is serving — only once there is a bucket */}
          {hasSiteBucket && (
            <TabsContent
              value="files"
              {...section("files")}
              // stacked, a site uploaded as files has no env: its files take the right column instead
              {...(stacked && uploadedSite
                ? { className: `${section("files", false).className} md:col-start-2 md:row-start-1 md:self-stretch [&>div]:h-full` }
                : {})}
            >
              <SiteFilesCard appId={application.id} />
            </TabsContent>
          )}

          {/* Logs Tab */}
          <TabsContent value="logs" className="space-y-6">
            <Card className="bg-gradient-card border-border/50">
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Terminal className="h-5 w-5 text-primary" />
                  <span>{t("Service Logs")}</span>
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
          {/* in a project: a section of its page, only its own deploys (the history is the source's) */}
          <TabsContent value="deployments" {...section("deployments")}>
            <DeploymentHistory application={application} onlyApp={stacked ? application.id : undefined} />
          </TabsContent>

          {/* Build Tab */}
          {/* stacked: the same form, in the Deployment card's Edit dialog */}
          {showBuild && stacked && (
            <Dialog open={buildOpen} onOpenChange={setBuildOpen}>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>{t("Build Settings")}</DialogTitle>
                </DialogHeader>
                <ApplicationSettingsForm application={application} detected={detection.data} />
                {application.type === "COMPOSE" && <StackExecCard applicationId={application.id} defaultService={application.composeService ?? null} />}
              </DialogContent>
            </Dialog>
          )}
          {showBuild && !stacked && (
            <TabsContent value="build" {...section("build")}>
              <Card className="bg-gradient-card border-border/50">
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <Settings className="h-5 w-5 text-primary" />
                    <span>{t("Build Settings")}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  <ApplicationSettingsForm application={application} detected={detection.data} />
                {application.type === "COMPOSE" && <StackExecCard applicationId={application.id} defaultService={application.composeService ?? null} />}
                </CardContent>
              </Card>
            </TabsContent>
          )}

          {/* Settings Tab */}
          <TabsContent value="settings" {...section("settings")}>
            {/* a static site keeps its files in R2, not on a node; measured (du
                over SSH) only while Settings is open — TabsContent unmounts */}
            {/* in a project, storage is the project's (its releases, cache and checkout): its Settings tab */}
            {!isStatic && !stacked && <AppStorageCard appId={application.id} deploying={deploying} />}
            <DangerZoneCard application={application} />
          </TabsContent>
        </Tabs>
          </div>
        </div>

        {confirmDeploy.dialog}
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


        <RestartDialog name={application.name} open={confirmRestart} onOpenChange={setConfirmRestart} onConfirm={() => restartApp.mutate(application.id)} />

        <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("Stop Service")}</AlertDialogTitle>
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
                {t("Stop Service")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          open={confirmPm2Build}
          onOpenChange={(open) => {
            setConfirmPm2Build(open);
            setPm2Consent(false);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("Build and restart {name} on the server?", { name: application.processName ?? "" })}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("Runs the install and the build in {dir}, then pm2 restart {name}. It builds in the folder that is serving: the site may show errors until the restart. If a step fails, the ones after it do not run.", {
                  dir: application.rootPath ?? "",
                  name: application.processName ?? "",
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={pm2Consent} onCheckedChange={(checked) => setPm2Consent(checked === true)} className="mt-0.5" />
              <span>{t("I understand the site may err until the build is done and pm2 has restarted it.")}</span>
            </label>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
              <AlertDialogAction disabled={!pm2Consent || pm2Build.isPending} onClick={() => pm2Build.mutate(pm2Consent)}>
                {t("Build & restart")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {repointHost && (
          <RepointDialog
            applicationId={application.id}
            name={application.domains.find((d) => d.host === repointHost) ?? { host: repointHost }}
            onClose={() => setRepointHost(null)}
            onConfirm={() => {
              setupDns.mutate({ id: application.id, host: repointHost, force: true });
              setRepointHost(null);
            }}
          />
        )}
      </div>
    </TooltipProvider>
  );
}

/**
 * A dialog whose content stays mounted while it is closed — a form in it keeps
 * its unsaved edits, and whatever reads its state (the setup checklist, the
 * deploy's save-first) keeps working. Radix's Dialog unmounts its content.
 * ponytail: no focus trap; Escape and the backdrop close it.
 */
function KeptModal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <div className={open ? "fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" : "hidden"} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // a column bounded to the screen: the title and the form's footer stay, only its body scrolls
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border bg-background p-6 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex shrink-0 items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("Close")} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
}

// Application Settings Form Component
interface ApplicationSettingsFormProps {
  application: Application;
  /** what the code implies — shown as each empty field's default */
  detected?: DetectedProject | null;
  /** on the project's tabs: system requirements sit on the Build card and the stack on its own tab — not repeated here */
  inTabs?: boolean;
}

/** "a, b" -> ["a", "b"]; an empty box means the default, not an empty list. */
const splitList = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

/** The system requirements a service may ask for — the keys backend/src/lib/systemPackages.ts accepts. */
const SYSTEM_PACKAGES = [
  {
    key: "libreoffice",
    name: "LibreOffice",
    // the same test the deploy makes (backend lib/systemPackages): an env var naming it
    mentions: /libre[_\s-]?office|soffice/i,
    // translated where shown: t() here would run once, at import
    description: "Convert documents (docx, xlsx, pptx → PDF) with soffice --headless. About 400 MB on the server, the first deploy takes a few minutes longer.",
  },
];

/** The system requirements, ticked in place — each tick saved at once. The project's Build card. */
export function SystemRequirements({ application }: { application: Application }) {
  const updateApp = useUpdateApplication();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const selected = application.systemPackages ?? [];
  const toggle = async (key: string, on: boolean) => {
    try {
      await updateApp.mutateAsync({ id: application.id, data: { systemPackages: on ? [...selected, key] : selected.filter((k) => k !== key) } });
      void queryClient.invalidateQueries({ queryKey: ['application', application.id] });
    } catch {
      toast({ title: t('Error'), description: t('Failed to update service settings'), variant: 'destructive' });
    }
  };
  return (
    <div className="space-y-2">
      {SYSTEM_PACKAGES.map((pkg) => {
        const on = selected.includes(pkg.key);
        const from = Object.entries(application.envVars ?? {}).find(([name, value]) => pkg.mentions.test(name) || pkg.mentions.test(String(value)))?.[0];
        return (
          <label key={pkg.key} className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm">
            <Checkbox checked={on} disabled={updateApp.isPending} onCheckedChange={(checked) => void toggle(pkg.key, checked === true)} className="mt-0.5" />
            <span>
              <span className="font-medium">{pkg.name}</span>
              <span className="block text-xs text-muted-foreground">{t(pkg.description)}</span>
              {from && !on && <span className="mt-1 block text-xs text-primary">{t("Detected from env {key} — installed at deploy even unticked.", { key: from })}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

const settingsOf = (application: Application) => ({
  composeFiles: (application?.composeFiles || []).join(', '),
  composeEnvFiles: (application?.composeEnvFiles || []).join(', '),
  composePort: application?.composePort?.toString() || '',
  composeService: application?.composeService || '',
  packageManager: application?.packageManager || '',
  installCommand: application?.installCommand || '',
  buildCommand: application?.buildCommand || '',
  preDeployCommand: application?.preDeployCommand || '',
  pruneDevDeps: !!application?.pruneDevDeps,
  systemPackages: application?.systemPackages ?? [],
  startCommand: application?.startCommand || '',
  port: application?.port?.toString() || '',
});

export function ApplicationSettingsForm({ application, detected, inTabs = false }: ApplicationSettingsFormProps) {
  const [formData, setFormData] = useState(() => settingsOf(application));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();
  const updateApp = useUpdateApplication();
  const queryClient = useQueryClient();
  const isStatic = application.type === 'STATIC';
  // A stack is not built or started here: its images are built by compose on
  // the node, and what it needs instead is which files to read.
  const isCompose = application.type === 'COMPOSE';
  const buildable = !isStatic && !isCompose;

  const handleInputChange = (field: string, value: string | boolean | string[]) => {
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
        packageManager: formData.packageManager,
        installCommand: formData.installCommand,
        buildCommand: formData.buildCommand || undefined,
        preDeployCommand: formData.preDeployCommand,
        pruneDevDeps: formData.pruneDevDeps,
        systemPackages: formData.systemPackages,
        startCommand: formData.startCommand || undefined,
        port: formData.port ? parseInt(formData.port) : undefined,
        // every type's: where its deploy writes the env
        composeEnvFiles: splitList(formData.composeEnvFiles),
        ...(isCompose && {
          composeFiles: splitList(formData.composeFiles),
          composePort: formData.composePort ? parseInt(formData.composePort) : null,
          composeService: formData.composeService || null,
        }),
      };

      await updateApp.mutateAsync({ id: application.id, data: updateData });
      
      toast({
        title: t('Success'),
        description: t('Service settings updated successfully'),
      });
      
      // Refetch application data
      queryClient.invalidateQueries({ queryKey: ['application', application.id] });
      
    } catch (error) {
      toast({
        title: t('Error'),
        description: t('Failed to update service settings'),
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
    // header (the dialog's), body that scrolls, footer that stays — the same shell as the env dialog
    <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
      <DialogBody className="space-y-6">
      {/* Package manager — the lockfile's unless chosen; pnpm over npm's lockfile runs pnpm import */}
      {buildable && (
        <div className="space-y-2">
          <label className="text-sm font-medium">{t("Package Manager")}</label>
          <Select value={formData.packageManager || 'auto'} onValueChange={(v) => handleInputChange('packageManager', v === 'auto' ? '' : v)}>
            <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t("Automatic")}{detected?.packageManager ? ` (${detected.packageManager})` : ''}</SelectItem>
              {['npm', 'pnpm', 'yarn', 'bun'].map((pm) => <SelectItem key={pm} value={pm}>{pm}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {formData.packageManager === 'pnpm' || !formData.packageManager
              ? t("pnpm unless the repository uses yarn or bun. Pick npm to keep npm.") + " " + t("Without a pnpm-lock.yaml, the build runs pnpm import first — nothing to commit.")
              : null}
          </p>
        </div>
      )}

      {/* every type: an app (or stack) can read its env from more than one file */}
      <div className="space-y-2">
        <label className="text-sm font-medium">{t("Env files")}</label>
        <Input
          value={formData.composeEnvFiles}
          onChange={(e) => handleInputChange('composeEnvFiles', e.target.value)}
          placeholder=".env"
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">
          {t("Where this service's environment variables are written on every deploy. Separated by commas; empty = .env. What the repository ships in them is kept, except for the keys set here.")}
        </p>
      </div>

      {isCompose && (
        <>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t("Compose files")}</label>
            <Input
              value={formData.composeFiles}
              onChange={(e) => handleInputChange('composeFiles', e.target.value)}
              placeholder="docker-compose.yml"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              {t("Separated by commas, in the order compose reads them — a later file overrides an earlier one. Relative to the service's folder. Empty = docker-compose.yml.")}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t("Service")}</label>
              <ComposeServiceSelect
                applicationId={application.id}
                value={formData.composeService}
                typeable
                onPick={(service, port) => setFormData((prev) => ({ ...prev, composeService: service, composePort: port || prev.composePort }))}
              />
              <p className="text-xs text-muted-foreground">{t("The service that serves traffic, and the one commands run in by default.")}</p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t("Container port")}</label>
              <Input
                value={formData.composePort}
                onChange={(e) => handleInputChange('composePort', e.target.value)}
                placeholder="5000"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                {t("The port that service listens on inside the stack. The platform republishes it on loopback and points the domain at it; leave both empty to keep whatever the compose file publishes.")}
              </p>
            </div>
          </div>

          {!inTabs && <ComposePreview applicationId={application.id} selected={formData.composeService} />}
        </>
      )}

      {/* Install Command — Node/PHP only; a static upload never installs */}
      {buildable && (
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

      {/* Build Command — a static site from a repository is built too (Vite, CRA…) */}
      {(buildable || isStatic) && (
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
      )}

      {/* Pre-deploy — migrations, before the build and before the release goes live */}
      {buildable && (
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
            {t("Runs before the build with the service's environment, so the build can use the tables. If it fails, the old release keeps serving — use it for database migrations.")}
          </p>
        </div>
      )}

      {/* smaller releases: devDependencies go after the build. Skipped by the deploy when the start command runs one (tsx, nodemon) */}
      {buildable && (
        <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm">
          <Checkbox checked={formData.pruneDevDeps} onCheckedChange={(checked) => handleInputChange('pruneDevDeps', checked === true)} className="mt-0.5" />
          <span>
            <span className="font-medium">{t("Remove devDependencies after the build")}</span>
            <span className="block text-xs text-muted-foreground">
              {t("typescript, the prisma CLI, @types and the like leave the release once it is built — often half of node_modules. Kept when the start command runs one of them (tsx, ts-node, nodemon). The next build installs afresh instead of reusing the trimmed node_modules.")}
            </span>
          </span>
        </label>
      )}

      {/* what the app needs on its server: a record the deploy acts on, not a switch — once installed, every app there has it */}
      {buildable && !inTabs && (
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("System Package")}</p>
          <p className="text-xs text-muted-foreground">{t("Installed on this service's server at deploy, if missing. Shared by the server's services and never removed.")}</p>
          {SYSTEM_PACKAGES.map((pkg) => (
            <label key={pkg.key} className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm">
              <Checkbox
                checked={formData.systemPackages.includes(pkg.key)}
                onCheckedChange={(checked) =>
                  handleInputChange('systemPackages', checked === true ? [...formData.systemPackages, pkg.key] : formData.systemPackages.filter((key) => key !== pkg.key))
                }
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">{pkg.name}</span>
                <span className="block text-xs text-muted-foreground">{t(pkg.description)}</span>
                {(() => {
                  const from = Object.entries(application.envVars ?? {}).find(([name, value]) => pkg.mentions.test(name) || pkg.mentions.test(String(value)))?.[0];
                  return from && !formData.systemPackages.includes(pkg.key) ? (
                    <span className="mt-1 block text-xs text-primary">{t("Detected from env {key} — installed at deploy even unticked.", { key: from })}</span>
                  ) : null;
                })()}
              </span>
            </label>
          ))}
        </div>
      )}

      {/* a static site is served, not started: no start command, no port */}
      {buildable && <>
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

      </>}

      {/* Help Section */}
      {buildable && <div className="bg-muted/50 rounded-lg p-4 space-y-3">
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
      </DialogBody>

      {/* Action Buttons — the footer: outside what scrolls, so Save stays in view in a dialog */}
      <DialogFooter className="mt-4 items-center justify-between border-t pt-4 sm:justify-between">
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
      </DialogFooter>
    </form>
  );
} 
