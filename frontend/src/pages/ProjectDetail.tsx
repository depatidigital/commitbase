import { useEffect, useRef, useState } from "react";
import { useDeploymentHistory } from "@/hooks/useDeployments";
import { DeployProgress } from "@/components/DeployProgress";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Cloud, FolderOpen, Globe, Layers, GitBranch, Hammer, HardDrive, Info, KeyRound, Loader2, MoreVertical, Pencil, Play, Plus, RefreshCw, Square, Terminal, Trash2, Upload } from "lucide-react";
import { RoutingCard } from "@/components/RoutingCard";
import { ComposePreview } from "@/components/ComposePreview";
import { ServerEnv } from "@/components/ServerEnv";
import { AppEnvironment } from "@/components/AppEnvironment";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useApplication, useCreateApplication, useRestartApplication, useStartApplication, useStartExistingApplication, useStopApplication } from "@/hooks/useApplications";
import { AppSetupCard, DeployFailureFixes } from "@/components/AppSetupCard";
import { useDeployConfirm } from "@/components/DeployConfirmDialog";
import { envWarnings, parseDatabaseUrl, requiredKeys } from "@/lib/env";
import { testDatabaseUrl } from "@/lib/databases";
import { stripAnsi } from "@/lib/ansi";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import DeploymentHistory, { BuildLogTail, DeployLogDialog, deploymentStatusLabel } from "@/components/DeploymentHistory";
import { DangerZoneCard } from "@/components/DangerZoneCard";
import { StackExecCard } from "@/components/StackExecCard";
import { SiteFilesCard } from "@/components/SiteFilesCard";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AppDatabasesTab } from "@/components/AppDatabasesTab";
import { ProjectLogs } from "@/components/ProjectLogs";
import { AppStorageCard } from "@/components/AppStorageCard";
import { SourcePanel } from "@/components/SourcePanel";
import { ProjectMembersCard } from "@/components/ProjectMembersCard";
import { PageLayout } from "@/components/PageLayout";
import { RenameAppDialog, RenameProjectDialog } from "@/components/RenameProjectDialog";
import { AppTypeBadge } from "@/components/AppTypeBadge";
import { ApplicationSettingsForm, Field } from "./ApplicationDetail";
import { useToast } from "@/hooks/use-toast";
import { type Application, type DetectedProject, type StartOptions, bindingLabel, cancelDeployment, deleteApplication, detectProject, failedMigrationOf, getAppDetection, getApplication, hasBeenDeployed, updateApplication, hostList, isPublicHost, repoName, runtimeLabel } from "@/lib/applications";
import { appStatus, getApplicationHealth, type Health } from "@/lib/health";
import { isSuperAdmin } from "@/lib/auth";
import { locale, t } from "@/lib/i18n";
import { APP_NAME } from "@/lib/branding";
import { expectedRows } from "@/lib/env";
import { formatBytes, timeAgo } from "@/lib/utils";
import { buildProject, deployProject, getProject, type ProjectApp } from "@/lib/projects";

const DOT: Record<string, string> = {
  up: "bg-success",
  down: "bg-destructive",
  warn: "bg-warning",
  deploying: "bg-warning animate-pulse",
  muted: "bg-muted-foreground/40",
};

/**
 * A project ("Proyek") and its apps ("Aplikasi"), on one page: the project's
 * tabs — its apps and their routes, logs, history, databases, storage,
 * settings — beside its state, source and server. An app card opens in the
 * list for a quick edit, or a level deeper (?service=) with its own header and
 * page; the back arrow returns. The same for a project of one app as of many.
 */
export default function ProjectDetail() {
  const { id = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const superAdmin = isSuperAdmin();

  const { data: project, isLoading, error } = useQuery({
    queryKey: ["project", id],
    queryFn: () => getProject(id),
    // faster while a deploy runs — or waits in the queue
    refetchInterval: (q) =>
      q.state.data?.status === "DEPLOYING" || ["PENDING", "BUILDING", "DEPLOYING"].includes(q.state.data?.lastDeployment?.status ?? "") ? 3_000 : 10_000,
  });
  const appIds = project?.applications.map((app) => app.id) ?? [];
  const { data: healthById = {} } = useQuery({
    queryKey: ["applications", "health", appIds],
    queryFn: () => getApplicationHealth(appIds),
    enabled: appIds.length > 0,
    refetchInterval: 15_000,
  });

  // delete the project = delete every app of it, one after the other
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  // compose apps' volumes (their databases) are kept unless ticked
  const [removeVolumes, setRemoveVolumes] = useState(false);
  // build every imported app where it lives — asked first, with a tick
  const [confirmBuild, setConfirmBuild] = useState(false);
  const [buildConsent, setBuildConsent] = useState(false);
  const [building, setBuilding] = useState(false);
  // where it runs, its folder, its ids: out of the way, a click from the header
  const [showDetails, setShowDetails] = useState(false);
  const [addingService, setAddingService] = useState(false);
  // the header's place for the source panel's main button (the panel is in Settings)
  const [sourceSlot, setSourceSlot] = useState<HTMLSpanElement | null>(null);
  // a panel-managed project deploys as one, from its source panel
  const deploy = useMutation({
    mutationFn: ({ skip = [], only }: { skip?: string[]; only?: string[] } = {}) => deployProject(id, skip, only),
    onSuccess: () => {
      toast({ title: t("Deploying") });
      void queryClient.invalidateQueries({ queryKey: ["project", id] });
      void queryClient.invalidateQueries({ queryKey: ["deployments"] });
      void queryClient.invalidateQueries({ queryKey: ["application"] });
    },
    onError: (error: Error) => toast({ variant: "destructive", title: t("Could not start the deployment"), description: error.message }),
  });
  // the app's tab (?tab=). Its services have no page of their own anymore: everything is on these tabs
  const tab = ["env", "build", "deployments", "stack", "logs", "database", "storage", "settings"].includes(searchParams.get("tab") ?? "") ? searchParams.get("tab")! : "apps";
  const go = (next: string) => setSearchParams(next === "apps" ? {} : { tab: next }, { replace: true });
  // a step into the app: the browser's back comes out again
  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (error || !project) {
    return <p className="p-6 text-destructive">{(error as Error | null)?.message ?? t("App not found")}</p>;
  }

  const apps = project.applications;
  const statusOf = (appId: string) => {
    const app = apps.find((a) => a.id === appId)!;
    return appStatus(app.status, healthById[app.id] as Health | undefined, app.disabled);
  };
  const imported = project.kind === "IMPORTED";
  // a deploy in flight: a service building, or the newest deployment still queued or running
  // (queued, no service has changed its status yet)
  const deploying =
    project.status === "DEPLOYING" || ["PENDING", "BUILDING", "DEPLOYING"].includes(project.lastDeployment?.status ?? "") || deploy.isPending;
  // what the panel's own services take: a tree on the node, or a static site's files in R2
  const hasStorage = !!apps[0];

  const origin = project.repository ? (
    <>
      <GitBranch className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate font-mono text-xs">
        {repoName(project.repository)} · {project.branch || "main"}
      </span>
    </>
  ) : imported ? (
    <>
      <HardDrive className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate text-xs">{project.path ? t("Server folder (not git)") : t("On the server (folder not detected)")}</span>
    </>
  ) : (
    <>
      <Upload className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate text-xs">{t("Uploaded files")}</span>
    </>
  );

  const deleteAll = async () => {
    for (const app of apps) {
      setDeleting(app.name);
      try {
        await deleteApplication(app.id, { removeVolumes });
      } catch (err) {
        setDeleting(null);
        setConfirmDelete(false);
        void queryClient.invalidateQueries({ queryKey: ["project", id] });
        toast({
          variant: "destructive",
          title: t("Stopped at {app}", { app: app.name }),
          description: `${(err as Error).message} — ${t("the services before it are deleted, the rest are kept.")}`,
        });
        return;
      }
    }
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
    void queryClient.invalidateQueries({ queryKey: ["applications"] });
    toast({ title: t("App deleted"), description: t("{count} services deleted", { count: apps.length }) });
    navigate("/apps");
  };

  return (
    <PageLayout
      backTo="/apps"
      title={
        <span className="flex items-center gap-2">
          {project.name}
          <RenameProjectDialog project={project} />
        </span>
      }
      // what it is built from; where it runs is in the advanced details (ⓘ)
      description={<span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">{origin}</span>}
      actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* what is live, and since when — the last deploy or pull */}
            {project.lastDeployment && (
              <span
                className="mr-1 text-xs text-muted-foreground"
                title={[new Date(project.lastDeployment.createdAt).toLocaleString(locale), project.lastDeployment.commitMessage].filter(Boolean).join(" · ")}
              >
                {t("Last commit")}: {project.lastDeployment.commitHash ? <span className="font-mono">{project.lastDeployment.commitHash.slice(0, 7)}</span> : "—"} ·{" "}
                {timeAgo(project.lastDeployment.createdAt)}
              </span>
            )}
            {/* the source's main button (pull, deploy the branch), put here by its panel in Settings */}
            <span ref={setSourceSlot} className="contents" />
            {/* imported: every service built where it lives — the sites' files, then the processes */}
            {imported && project.canSwitchBranch && (
              <Button variant="outline" disabled={deploying || building} onClick={() => setConfirmBuild(true)}>
                {deploying || building ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Hammer className="mr-2 h-4 w-4" />}
                {t("Redeploy")}
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={() => setShowDetails(true)} aria-label={t("Advanced details")} title={t("Advanced details")}>
              <Info className="h-4 w-4" />
            </Button>
          </div>
      }
    >
      {/* the same tabs for an app of one service as of many */}
      <Tabs value={tab} onValueChange={(next) => go(next)} className="min-w-0 space-y-6">
        <TabsList>
          <TabsTrigger value="apps">{t("Services")}</TabsTrigger>
          <TabsTrigger value="env">{t("Environment")}</TabsTrigger>
          <TabsTrigger value="build">{t("Build")}</TabsTrigger>
          <TabsTrigger value="deployments">{t("Deployments")}</TabsTrigger>
          {apps.some((app) => app.type === "COMPOSE") && <TabsTrigger value="stack">{t("Stack")}</TabsTrigger>}
          <TabsTrigger value="database">{t("Database")}</TabsTrigger>
          {hasStorage && <TabsTrigger value="storage">{t("Storage")}</TabsTrigger>}
          <TabsTrigger value="logs">{t("Logs")}</TabsTrigger>
          <TabsTrigger value="settings">{t("Settings")}</TabsTrigger>
        </TabsList>

        {/* its apps and their routes — an app has many (host, host/path), a route belongs to one app.
            A card opens that app a level deeper */}
        {/* what is going on — a deploy running or failed, a setup checklist — above the rows; one row per service */}
        <TabsContent value="apps" className="space-y-3">
          {apps.map((app) => (
            <ServiceAlerts key={app.id} appId={app.id} named={apps.length > 1} />
          ))}
          {apps.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">{t("No services")}</p>
          ) : (
            <div className="overflow-hidden rounded-lg border bg-card">
              {/* fixed widths: the host gets the room, the short columns only what they need */}
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[20%] text-xs uppercase tracking-wide">{t("Service")}</TableHead>
                    <TableHead className="text-xs uppercase tracking-wide">{t("Host")}</TableHead>
                    <TableHead className="w-44 text-xs uppercase tracking-wide">{t("Last deploy")}</TableHead>
                    <TableHead className="w-32 text-xs uppercase tracking-wide">{t("Type")}</TableHead>
                    <TableHead className="w-36 text-xs uppercase tracking-wide">{t("Folder")}</TableHead>
                    <TableHead className="w-32">
                      <span className="sr-only">{t("Actions")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {apps.map((app) => (
                    <ServiceRow key={app.id} app={app} status={statusOf(app.id)} only={apps.length === 1} />
                  ))}
                </TableBody>
              </Table>
              {/* one more service from this app's repository — a folder, the rest detected */}
              {!imported && project.repository && (
                <div className="border-t px-2 py-1.5">
                  <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={() => setAddingService(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    {t("Add service")}
                  </Button>
                  <QuickAddService projectId={project.id} open={addingService} onOpenChange={setAddingService} />
                </div>
              )}
            </div>
          )}
        </TabsContent>

        {/* every service's env on one tab, one section each — no need to open a service for it */}
        {/* side by side when there are several: web's env next to the api's, where they must agree
            (an editable form needs the room: two columns from xl) */}
        <TabsContent value="env" className={apps.length > 1 ? "grid items-start gap-4 xl:grid-cols-2" : "space-y-4"}>
          {apps.map((app) => (
            <ServiceEnvSection key={app.id} appId={app.id} />
          ))}
        </TabsContent>

        {/* how each service is built and run: its deployment settings, one section each — side by side like Environment */}
        <TabsContent value="build" className={apps.length > 1 ? "grid items-start gap-4 xl:grid-cols-2" : "space-y-4"}>
          {apps.map((app) => (
            <ServiceBuildSection key={app.id} appId={app.id} />
          ))}
        </TabsContent>

        {/* every service's log in one live stream, or one service's — followed only while this tab is open */}
        {/* every deploy of the app, newest first — each names its service when there are several */}
        <TabsContent value="deployments">{apps[0] && <AppDeployments appId={apps[0].id} showApp={apps.length > 1} />}</TabsContent>

        {/* a compose service's own services (web, db, solr…), as its compose files define them */}
        <TabsContent value="stack" className="space-y-4">
          {apps
            .filter((app) => app.type === "COMPOSE")
            .map((app) => (
              <StackSection key={app.id} app={app} />
            ))}
        </TabsContent>

        <TabsContent value="logs">
          <ProjectLogs projectId={project.id} apps={apps} />
        </TabsContent>

        {/* the databases its apps share — connected from each app's Environment */}
        <TabsContent value="database">
          <AppDatabasesTab projectId={project.id} />
        </TabsContent>

        {/* the project as a whole: what its tree takes on its node (releases, build cache, checkout, logs —
            measured on open), and deleting it, which deletes every app of it */}
        {/* what its tree takes on its node — releases, build cache, checkout, logs. The panel's own projects
            keep them; an imported one's files are whoever set it up's. Any app of it measures the source's tree */}
        {hasStorage && (
          <TabsContent value="storage">
            <div className="space-y-4">
              {/* every service with a tree on the node — not uploaded files (in object storage), not imported ones */}
              {apps
                // a tree on the node: the panel's own (not static: R2), and imported ones (their folder, pm2 logs)
                .filter((app) => app.runtime || app.type !== "STATIC")
                .map((app) => (
                  <AppStorageCard key={app.id} appId={app.id} deploying={deploying} title={apps.length > 1 ? app.name : undefined} />
                ))}
              {/* a static site's files are in R2, not on the node: the size the cron measures there */}
              {apps
                .filter((app) => app.type === "STATIC" && !app.runtime)
                .map((app) => (
                  <Card key={app.id}>
                    <CardContent className="flex items-center justify-between gap-3 p-4">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 font-medium">
                          <Cloud className="h-4 w-4 shrink-0 text-primary" />
                          <span className="truncate">{app.name}</span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t("Static files in object storage (R2), every release.")}
                          {app.diskMeasuredAt && (
                            <span title={new Date(app.diskMeasuredAt).toLocaleString(locale)}> · {t("measured {ago}", { ago: timeAgo(app.diskMeasuredAt) })}</span>
                          )}
                        </p>
                      </div>
                      <span className="shrink-0 font-medium">{app.diskBytes != null ? formatBytes(app.diskBytes, locale) : "—"}</span>
                    </CardContent>
                  </Card>
                ))}
            </div>
          </TabsContent>
        )}

        {/* as the API allows it: the panel's own apps, anyone who manages them; apps set up on the server, a superadmin only */}
        <TabsContent value="settings" forceMount className="space-y-6 data-[state=inactive]:hidden">
          {project.repository && (
            <SourcePanel
              projectId={project.id}
              onDeploy={(skipPreDeployFor, only) => deploy.mutate({ skip: skipPreDeployFor ?? [], only })}
              starting={deploy.isPending}
              deploying={deploying}
              actionSlot={sourceSlot}
            />
          )}
          <ProjectMembersCard projectId={project.id} />
          {apps.length > 0 && (
            <Card className="border-destructive/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-destructive">
                  <AlertTriangle className="h-5 w-5" />
                  {t("Danger zone")}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0 text-sm">
                  <p className="font-medium">{t("Delete this app")}</p>
                  <p className="text-muted-foreground">
                    {t("Every service of it is deleted too ({count}): {apps}.", { count: apps.length, apps: apps.map((app) => app.name).join(", ") })}{" "}
                    {imported
                      ? t("They were set up on the server: their process, Caddy route, DNS record and folder are removed from it too.")
                      : t("This cannot be undone.")}
                  </p>
                  {imported && !superAdmin && (
                    <p className="mt-1 text-xs text-muted-foreground">{t("Only a superadmin can remove things from the server.")}</p>
                  )}
                  {!imported && !project.canManage && (
                    <p className="mt-1 text-xs text-muted-foreground">{t("Only the creator of the app and the admins of its workspace can delete it.")}</p>
                  )}
                </div>
                <Button
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  disabled={imported ? !superAdmin : !project.canManage}
                  onClick={() => {
                    setTyped("");
                    setConfirmDelete(true);
                  }}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t("Delete app")}
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={showDetails} onOpenChange={setShowDetails}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("Advanced details")}</DialogTitle>
          </DialogHeader>
          <div className="text-sm">
            <Field label={t("Source")}>
              <span className="inline-flex min-w-0 items-center gap-1.5">{origin}</span>
            </Field>
            {project.repository && (
              <Field label={t("Repository")}>
                <span className="break-all font-mono text-xs">{project.repository}</span>
              </Field>
            )}
            <Field label={t("Built by")}>{imported ? t("Its server (imported)") : APP_NAME}</Field>
            <Field label={t("Workspace")}>{project.organization?.name ?? t("Unassigned")}</Field>
            <Field label={t("Server")}>
              {project.server ? (
                superAdmin ? (
                  <Link to={`/servers/${project.server.id}`} className="hover:text-primary hover:underline">
                    {project.server.name}
                  </Link>
                ) : (
                  project.server.name
                )
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </Field>
            {/* imported: the checkout on its server — where a pull, a branch switch and a build run */}
            {project.path && (
              <Field label={t("Checkout")}>
                <span className="break-all font-mono text-xs">{project.path}</span>
              </Field>
            )}
            <Field label={t("Created")}>{new Date(project.createdAt).toLocaleString(locale)}</Field>
            <Field label="ID">
              <span className="break-all font-mono text-xs">{project.id}</span>
            </Field>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmBuild}
        onOpenChange={(open) => {
          setConfirmBuild(open);
          setBuildConsent(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Redeploy every service of {name}?", { name: project.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("Each service is installed and built in its folder on the server, one after the other: the sites' files first, then the processes, which pm2 restarts. They build in the folders that are serving, so the sites may show errors meanwhile.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={buildConsent} onCheckedChange={(checked) => setBuildConsent(checked === true)} className="mt-0.5" />
            <span>{t("I understand the sites may err until every build is done.")}</span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <Button
              disabled={!buildConsent || building}
              onClick={async () => {
                const consent = buildConsent;
                setBuilding(true);
                try {
                  const built = await buildProject(project.id, consent);
                  toast({ title: t("Building {count} services", { count: built.length }), description: built.join(", ") });
                  setConfirmBuild(false);
                  void queryClient.invalidateQueries({ queryKey: ["project", id] });
                  void queryClient.invalidateQueries({ queryKey: ["application"] });
                } catch (error) {
                  toast({ variant: "destructive", title: t("Could not start the build"), description: (error as Error).message });
                } finally {
                  setBuilding(false);
                }
              }}
            >
              {building && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("Redeploy")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={(open) => !deleting && setConfirmDelete(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Delete {name}?", { name: project.name })}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>{t("Every service of this app is deleted, one after the other:")}</p>
                <ul className="list-disc pl-5 text-xs">
                  {apps.map((app) => (
                    <li key={app.id}>
                      <span className="font-medium">{app.name}</span>
                      {hostList(app) && <span className="font-mono text-muted-foreground"> · {hostList(app)}</span>}
                    </li>
                  ))}
                </ul>
                {imported && (
                  <p className="font-medium text-destructive">
                    {t("They were set up on the server: their process, Caddy route, DNS record and folder are removed from it too.")}
                  </p>
                )}
                <p>{t("Type the app's name to confirm.")}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={project.name} disabled={!!deleting} />
          {apps.some((app) => app.type === "COMPOSE") && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={removeVolumes} onCheckedChange={(checked) => setRemoveVolumes(checked === true)} disabled={!!deleting} className="mt-0.5" />
              <span>{t("Also delete the containers' data (volumes). Their databases are gone for good.")}</span>
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!deleting}>{t("Cancel")}</AlertDialogCancel>
            <Button variant="destructive" disabled={typed.trim() !== project.name || !!deleting} onClick={() => void deleteAll()}>
              {deleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("Deleting {app}…", { app: deleting })}
                </>
              ) : (
                t("Delete app")
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageLayout>
  );
}

/**
 * What is going on with one service, above the app's service rows: a deploy
 * running (its progress and newest log lines), the last one failed (why, and
 * the ways out), or — never deployed — its setup checklist. Nothing otherwise.
 */
function ServiceAlerts({ appId, named }: { appId: string; /** several services: say whose */ named: boolean }) {
  // refetched by hand after a change made here (a host, a deploy): its own query, whatever a cache-wide invalidation reaches
  const { data: application, refetch: refetchApp } = useApplication(appId);
  const { toast } = useToast();
  // the checklist's Deploy: this app — every app deploys on its own
  const firstDeploy = useStartApplication();
  const queryClient = useQueryClient();
  // the checklist's steps: env and build are the app's tabs, hosts a dialog here
  const [, setSearchParams] = useSearchParams();
  const [hostsOpen, setHostsOpen] = useState(false);
  // never deployed, and ours to deploy: its setup checklist, as on its page
  const needsSetup =
    !!application && !(application.type === "STATIC" && !application.repository) && !application.runtime && !hasBeenDeployed(application);
  // the same query (and cache) as its page's checklist
  const detection = useQuery({
    queryKey: ["application", appId, "detect"],
    queryFn: () => getAppDetection(appId),
    // the panel's own apps from a repository: the checklist before the first deploy, the
    // detected commands on the card after it (an app deployed on detection's defaults has none saved)
    enabled: !!application && !application.runtime && !!application.repository,
    staleTime: 5 * 60_000,
    retry: false,
  });
  // before the first deploy, the saved DATABASE_URL tried from the app's node — as its page does, same cache:
  // a login that fails is said on the checklist, not found in a crashed app's logs
  const savedDbUrl = application?.envVars?.DATABASE_URL ?? "";
  const dbCheck = useQuery({
    queryKey: ["db-check", appId, application?.updatedAt],
    queryFn: () => testDatabaseUrl(appId, "DATABASE_URL"),
    enabled: needsSetup && !!parseDatabaseUrl(savedDbUrl).engine,
    staleTime: 60_000,
    retry: false,
  });
  // a deploy running: followed through its history (which polls itself while one runs),
  // its progress and build log shown on the card — as its page shows them
  const { data: history, refetch: refetchHistory } = useDeploymentHistory(appId);
  // the history is the source's, every app of it: this app's newest
  const newestDeploy = history?.data?.find((deployment) => deployment.applicationId === appId);
  // its deploys and their logs — the live one's too — in a dialog, not on the card
  const [logOpen, setLogOpen] = useState(false);
  // the click, the app (set DEPLOYING before the start answers), or its newest deployment — whichever says so first
  const inFlight =
    firstDeploy.isPending ||
    ["DEPLOYING", "BUILDING"].includes(application?.status ?? "") ||
    ["PENDING", "BUILDING", "DEPLOYING"].includes(newestDeploy?.status ?? "");
  const startDeployNow = (id: string, options: StartOptions = {}) =>
    firstDeploy.mutate({ id, ...options }, {
      // the new row and status at once — the history then polls itself until the deploy ends
      onSuccess: () => {
        void refetchHistory();
        void refetchApp();
      },
    });
  // an app with migrations is asked first (migrate on by default)
  const confirmDeploy = useDeployConfirm(application ?? undefined, (options) => startDeployNow(appId, options));
  const startDeploy = (_id: string, options: StartOptions = {}) => confirmDeploy.deploy(options);
  // when it ends: the app again — its status, its first release, its checklist gone
  const wasInFlight = useRef(false);
  useEffect(() => {
    if (inFlight) wasInFlight.current = true;
    else if (wasInFlight.current) {
      wasInFlight.current = false;
      void refetchApp();
      void queryClient.invalidateQueries({ queryKey: ["project"] });
    }
  }, [inFlight, refetchApp, queryClient]);
  const cancelDeploy = useMutation({
    mutationFn: () => cancelDeployment(appId),
    onSuccess: () => toast({ title: t("Cancelling the deployment…") }),
    onError: (error: Error) => toast({ variant: "destructive", title: t("Could not cancel the deployment"), description: error.message }),
  });
  if (!application) return null;
  const lastDeployment = application.deployments?.[0];
  // a site uploaded as files: nothing is built or run, and it is given no env — its files are what there is
  const uploadedSite = application.type === "STATIC" && !application.repository;
  // counted from the saved env: the form is in the Env dialog, saved before it closes
  // Before its first save every expected key counts. After it, what was saved is
  // the app's word: a key removed is not used, a key saved empty is empty on purpose.
  const missing =
    application.envConfirmed === false ? [...requiredKeys(detection.data)].filter((key) => !application.envVars?.[key]?.trim()) : [];
  // filled but likely wrong on the server (localhost…) — the same the Env dialog flags
  const warnings = envWarnings(Object.entries(application.envVars ?? {}).map(([key, value]) => ({ key, value })));
  const lastFailed =
    lastDeployment?.status === "FAILED"
      ? stripAnsi(lastDeployment.deployLogs || lastDeployment.buildLogs?.trim().split("\n").slice(-15).join("\n") || "")
      : "";
  if (!inFlight && !lastFailed && !needsSetup) return null;
  return (
    <div className="space-y-3 rounded-lg border bg-card p-3">
      {named && <p className="text-sm font-medium">{application.name}</p>}
      {inFlight && (
        <div className="rounded-md border border-primary/40 bg-primary/5 p-3">
          {/* where it is; its log in the dialog (Logs) */}
          <DeployProgress
            appId={application.id}
            status={newestDeploy?.status}
            redeploy={hasBeenDeployed(application)}
            published={application.type === "STATIC" ? !!application.staticBucket : application.status === "RUNNING"}
            showLog={false}
          />
          {/* the newest lines, so the card says what it is doing — the whole log is a click away */}
          {!uploadedSite && newestDeploy?.status !== "PENDING" && (
            <div className="mt-2">
              <BuildLogTail
                appId={application.id}
                text={application.runtime ? newestDeploy?.deployLogs ?? "" : undefined}
                onOpen={() => setLogOpen(true)}
              />
            </div>
          )}
          {/* under it, on their own line: the phases keep the width they need */}
          <div className="mt-2 flex flex-wrap items-center justify-end gap-1 border-t border-primary/20 pt-2">
            {!uploadedSite && (
              <Button variant="ghost" size="sm" onClick={() => setLogOpen(true)}>
                <Terminal className="h-3.5 w-3.5 mr-1.5" />
                {t("Logs")}
              </Button>
            )}
            {/* a pm2 build on the server runs to its end; the panel's own stops at its next step, the old release still live */}
            {!application.runtime && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={cancelDeploy.isPending}
                onClick={() => cancelDeploy.mutate()}
              >
                <Square className="h-3.5 w-3.5 mr-1.5" />
                {t("Cancel deploy")}
              </Button>
            )}
          </div>
        </div>
      )}
      {/* why the last deploy failed, on the card itself — the checklist below stays a checklist */}
      {!inFlight && lastFailed && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
                <AlertTriangle className="h-4 w-4" />
                {t("The last deploy failed")}
              </p>
              <p className="text-xs text-muted-foreground">{t("Whatever was serving before keeps serving.")}</p>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => setLogOpen(true)}>
                <Terminal className="h-3.5 w-3.5 mr-1.5" />
                {t("Logs")}
              </Button>
              <Button size="sm" className="bg-gradient-primary" disabled={firstDeploy.isPending} onClick={() => startDeploy(application.id)}>
                {firstDeploy.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
                {t("Retry deploy")}
              </Button>
            </div>
          </div>
          <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs text-destructive">{lastFailed}</pre>
          {/* a failed migration: its ways out, right under the reason */}
          <div className="mt-2">
            <DeployFailureFixes
              application={application}
              failure={lastFailed}
              failedMigration={lastDeployment?.status === "FAILED" ? failedMigrationOf(lastDeployment.buildLogs) : null}
              starting={firstDeploy.isPending}
              onDeploy={(options) => startDeploy(application.id, options)}
            />
          </div>
        </div>
      )}
      {/* while it deploys, the progress above says what the checklist would */}
      {needsSetup && !inFlight && (
        <AppSetupCard
          compact
          onEditHosts={() => setHostsOpen(true)}
          application={application}
          detected={detection.data}
          detecting={detection.isLoading}
          env={{ missing, warnings, dirty: false }}
          dbCheck={dbCheck.isFetching ? "pending" : dbCheck.data ?? null}
          // the failure and its ways out are above, not in the checklist
          failure={undefined}
          failedMigration={null}
          starting={firstDeploy.isPending || ["DEPLOYING", "BUILDING"].includes(application.status)}
          onDeploy={(options) => startDeploy(application.id, options)}
          onEditEnv={() => setSearchParams({ tab: "env" })}
          onEditBuild={() => setSearchParams({ tab: "build" })}
          onShowLog={() => setLogOpen(true)}
        />
      )}
      <RoutingCard application={application} dialogOnly editOpen={hostsOpen} onEditOpenChange={setHostsOpen} onChange={() => void refetchApp()} />
      {confirmDeploy.dialog}
      <DeployLogDialog
        application={application}
        open={logOpen}
        onOpenChange={setLogOpen}
        // a pm2 build on the server runs to its end
        onCancel={application.runtime ? undefined : () => cancelDeploy.mutate()}
        cancelling={cancelDeploy.isPending}
      />
    </div>
  );
}

/**
 * One service as a row of the app's Services tab: what it is, where it
 * answers, its last deploy, start/stop, and a menu for the rest (its files,
 * its console, deleting it). Services have no page of their own.
 */
function ServiceRow({ app, status, only }: { app: ProjectApp; status: { text: string; tone: string }; /** the app's one service: deleting it deletes the app */ only: boolean }) {
  const { data: application } = useApplication(app.id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // the menu's dialogs
  const [dialog, setDialog] = useState<"files" | "console" | "delete" | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const start = useStartExistingApplication();
  const stop = useStopApplication();
  const restart = useRestartApplication();
  const [confirmStop, setConfirmStop] = useState(false);
  const [hostsOpen, setHostsOpen] = useState(false);
  const deploying = ["DEPLOYING", "BUILDING"].includes(app.status);
  // redeploy this service alone: the panel's own through its deploy (migrations asked first),
  // an imported one built where it lives — only on a yes, its site can err meanwhile
  const redeploy = useStartApplication();
  const confirmRedeploy = useDeployConfirm(application ?? undefined, (options) => redeploy.mutate({ id: app.id, ...options }));
  const [confirmBuild, setConfirmBuild] = useState(false);
  const build = useMutation({
    mutationFn: () => startPm2Build(app.id, true),
    onSuccess: () => {
      toast({ title: t("Building {name}", { name: app.name }) });
      void queryClient.invalidateQueries({ queryKey: ["application", app.id] });
      void queryClient.invalidateQueries({ queryKey: ["deployments"] });
    },
    onError: (error: Error) => toast({ variant: "destructive", title: t("Could not start the build"), description: error.message }),
  });
  // a process the panel or pm2 starts and stops — not a PHP site or static files, nor someone else's;
  // started again from its built release, so one never deployed is deployed, not started.
  // COMPOSE is controllable: start/stop/restart map to compose up/stop/force-recreate
  const controllable =
    !!application &&
    (!application.runtime || application.runtime === "PM2") &&
    !["STATIC", "PHP"].includes(application.type) &&
    (!!application.runtime || hasBeenDeployed(application));
  const running = app.status === "RUNNING";
  const pending = start.isPending || stop.isPending || restart.isPending;
  const last = application?.deployments?.[0];
  // what serves it on the box: its pm2 process, Caddy's files or proxy
  const runtime = `${runtimeLabel(app.runtime)}${app.runtime === "PM2" && app.processName ? ` · ${app.processName}` : ""}`;
  const bindings = [...app.domains].sort((a, b) => a.host.localeCompare(b.host) || (a.path ?? "").localeCompare(b.path ?? ""));
  return (
    <TableRow className={`group ${app.disabled ? "opacity-50" : ""}`}>
      <TableCell>
        <span className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[status.tone]}`} title={status.text} />
          <span className="truncate font-medium">{app.name}</span>
          {/* rename in place: shown on row hover (and focus) */}
          <span className="shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <RenameAppDialog app={app} />
          </span>
          {deploying && (
            <span className="flex shrink-0 items-center gap-1 text-xs text-warning">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("Deploying")}
            </span>
          )}
        </span>
      </TableCell>
      <TableCell className="font-mono text-xs">
        {/* its hosts, added and changed in the hosts dialog */}
        <span className="flex items-start gap-1">
          {bindings.length === 0 ? (
            <Button variant="outline" size="sm" className="h-7 font-sans text-xs" disabled={!application} onClick={() => setHostsOpen(true)}>
              <Plus className="mr-1 h-3 w-3" />
              {t("Add host")}
            </Button>
          ) : (
            <>
              <span className="min-w-0">
                {bindings.map((d) => (
                  <span key={bindingLabel(d)} className="block truncate">
                    {d.host}
                    {d.path && <span className="text-muted-foreground">{d.path}</span>}
                  </span>
                ))}
              </span>
              <Button variant="ghost" size="icon" className="-my-1 h-6 w-6 shrink-0 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100" title={t("Edit hosts")} aria-label={t("Edit hosts")} disabled={!application} onClick={() => setHostsOpen(true)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
          {application && <RoutingCard application={application} dialogOnly editOpen={hostsOpen} onEditOpenChange={setHostsOpen} />}
        </span>
      </TableCell>
      <TableCell className="text-xs">
        {last ? (
          <span className="whitespace-nowrap" title={new Date(last.createdAt).toLocaleString(locale)}>
            <span className={last.status === "FAILED" ? "text-destructive" : ""}>{deploymentStatusLabel(last.status)}</span>
            <span className="text-muted-foreground"> · {timeAgo(last.createdAt)}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">{t("Never deployed")}</span>
        )}
      </TableCell>
      {/* what it is, and — only when it is not the panel's own — what serves it on the box (pm2, Caddy's files) */}
      <TableCell>
        <span className="flex flex-wrap items-center gap-1.5">
          <AppTypeBadge type={app.type} />
          {app.runtime && (
            <Badge variant="outline" className="border-warning/50 px-1.5 py-0 text-[10px] font-medium text-warning" title={app.rootPath ?? undefined}>
              {runtime}
            </Badge>
          )}
        </span>
      </TableCell>
      {/* its folder in the repository (monorepos); none = the root */}
      <TableCell className="font-mono text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1" title={app.rootDirectory || undefined}>
          <FolderOpen className="h-3 w-3 shrink-0" />
          <span className="truncate">{app.rootDirectory || "/"}</span>
        </span>
      </TableCell>
      <TableCell>
        <span className="flex items-center justify-end gap-1">
          {/* mid-deploy the process is the deploy's: not stopped or started by hand meanwhile */}
          {controllable &&
            !deploying &&
            (running ? (
              <>
                <Button variant="ghost" size="icon" className="h-8 w-8" title={t("Restart")} aria-label={t("Restart")} disabled={pending} onClick={() => restart.mutate(app.id)}>
                  <RefreshCw className={`h-4 w-4 ${restart.isPending ? "animate-spin" : ""}`} />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" title={t("Stop")} aria-label={t("Stop")} disabled={pending} onClick={() => setConfirmStop(true)}>
                  <Square className="h-4 w-4" />
                </Button>
              </>
            ) : (
              <Button variant="ghost" size="icon" className="h-8 w-8 text-primary" title={t("Start")} aria-label={t("Start")} disabled={pending} onClick={() => start.mutate(app.id)}>
                {start.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              </Button>
            ))}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t("Actions for {name}", { name: app.name })} disabled={!application}>
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={deploying || redeploy.isPending || build.isPending || (!!app.runtime && !["PM2", "CADDY_STATIC"].includes(app.runtime))}
                onClick={() => (app.runtime ? setConfirmBuild(true) : confirmRedeploy.deploy())}
              >
                <Rocket className="mr-2 h-4 w-4" />
                {t("Redeploy")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setRenameOpen(true)}>
                <Pencil className="mr-2 h-4 w-4" />
                {t("Rename service")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setHostsOpen(true)}>
                <Globe className="mr-2 h-4 w-4" />
                {t("Edit hosts")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* a site uploaded as files: its files are what there is */}
              {application?.type === "STATIC" && !application.repository && (
                <DropdownMenuItem onClick={() => setDialog("files")}>
                  <FolderOpen className="mr-2 h-4 w-4" />
                  {t("Site files")}
                </DropdownMenuItem>
              )}
              {application?.type === "COMPOSE" && (
                <DropdownMenuItem onClick={() => setDialog("console")}>
                  <Terminal className="mr-2 h-4 w-4" />
                  {t("Console")}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDialog("delete")}>
                <Trash2 className="mr-2 h-4 w-4" />
                {t("Delete service")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
        <RenameAppDialog app={app} open={renameOpen} onOpenChange={setRenameOpen} />
        {confirmRedeploy.dialog}
        <AlertDialog open={confirmBuild} onOpenChange={setConfirmBuild}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("Redeploy {name}?", { name: app.name })}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("It is installed, built and restarted in its folder on the server. The site may show errors until that is done.")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
              <AlertDialogAction onClick={() => build.mutate()}>{t("Redeploy")}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        {application && (
          <Dialog open={!!dialog} onOpenChange={(open) => !open && setDialog(null)}>
            <DialogContent className="max-h-[90vh] max-w-3xl overflow-auto">
              <DialogHeader>
                <DialogTitle>
                  {dialog === "files" ? t("Site files") : dialog === "console" ? t("Console") : t("Delete service")} — {app.name}
                </DialogTitle>
              </DialogHeader>
              {dialog === "files" && <SiteFilesCard appId={app.id} />}
              {dialog === "console" && <StackExecCard applicationId={app.id} defaultService={application.composeService ?? null} />}
              {dialog === "delete" && (
                <DangerZoneCard
                  application={application}
                  // the app's last service takes the app with it: back to the list; else stay on the app
                  onDeleted={() => {
                    setDialog(null);
                    if (only) navigate("/apps");
                    else void queryClient.invalidateQueries({ queryKey: ["project"] });
                  }}
                />
              )}
            </DialogContent>
          </Dialog>
        )}
        {/* stopping takes it offline: asked first, as on its page */}
        <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("Stop Service")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("Are you sure you want to stop \"{name}\"? This will shut down the running application.", { name: app.name })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
              <Button
                variant="destructive"
                onClick={() => {
                  stop.mutate(app.id);
                  setConfirmStop(false);
                }}
              >
                {t("Stop Service")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TableCell>
    </TableRow>
  );
}

/**
 * One service's env on the app's Environment tab, read: names, values masked
 * until shown, searchable. The panel's own services are edited in a dialog
 * (Edit); an imported one's is its .env on the server — changed there; uploaded
 * files have none.
 */
function ServiceEnvSection({ appId }: { appId: string }) {
  const { data: application } = useApplication(appId);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  // the same query (and cache) as the service's page
  const detection = useQuery({
    queryKey: ["application", appId, "detect"],
    queryFn: () => getAppDetection(appId),
    enabled: !!application && !application.runtime && !!application.repository,
    staleTime: 5 * 60_000,
    retry: false,
  });
  if (!application) return <Loader2 className="mx-auto my-6 h-5 w-5 animate-spin text-muted-foreground" />;
  const host = application.domains.map((d) => d.host).find(isPublicHost);
  const uploadedSite = application.type === "STATIC" && !application.repository;
  const editable = !uploadedSite && !application.runtime;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 pb-3">
        <CardTitle className="flex min-w-0 items-center gap-2 text-base">
          <KeyRound className="h-4 w-4 shrink-0 text-primary" />
          <span className="truncate">{application.name}</span>
          {host && !application.name.includes(host) && <span className="truncate font-mono text-xs font-normal text-muted-foreground">{host}</span>}
        </CardTitle>
        {editable && (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="mr-2 h-3.5 w-3.5" />
            {t("Edit env")}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {uploadedSite ? (
          <p className="text-sm text-muted-foreground">{t("Uploaded files have no environment variables.")}</p>
        ) : application.runtime ? (
          <ServerEnv env={application.envVars ?? {}} dir={application.rootPath} />
        ) : (
          <EnvFilesView application={application} detected={detection.data} />
        )}
      </CardContent>
      <Dialog
        open={editing}
        onOpenChange={(open) => {
          setEditing(open);
          // closed: read it again, so the view shows what is saved now
          if (!open) void queryClient.invalidateQueries({ queryKey: ["application", appId] });
        }}
      >
        {/* a flex column bounded to the screen: the title and Save stay, only the form's body scrolls */}
        <DialogContent className="flex max-h-[90vh] max-w-3xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>
              {t("Environment")} — {application.name}
            </DialogTitle>
          </DialogHeader>
          {editing && <Fresh appId={appId}>{(fresh) => <AppEnvironment application={fresh} detected={detection.data} />}</Fresh>}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * The panel's own service's env, read — per env file (a compose stack can have
 * several: CKAN's .env and .ckan-env). Until it is first saved, what the edit
 * form would start from: the repository's own env files and the keys its
 * .env.example expects, said to be not saved yet.
 */
function EnvFilesView({ application, detected }: { application: Application; detected?: DetectedProject | null }) {
  const unsaved = application.envConfirmed === false;
  const shipped = Object.fromEntries((detected?.env.files ?? []).map((f) => [f.file, Object.fromEntries(f.vars.map((v) => [v.key, v.value]))]));
  const configured = application.composeEnvFiles?.length ? application.composeEnvFiles : [".env"];
  const files = [...new Set([...configured, ...Object.keys(shipped)])];
  const envOf = (file: string, index: number): Record<string, string> => {
    const saved = index === 0 ? application.envVars ?? {} : application.extraEnvVars?.[file] ?? {};
    if (!unsaved) return saved;
    const expected = index === 0 ? Object.fromEntries(expectedRows(detected).map((row) => [row.key, row.value])) : {};
    return { ...expected, ...shipped[file], ...saved };
  };
  const note = unsaved ? (
    <span className="text-warning">{t("Not saved yet — what the repository ships and its .env.example expects. Saved with Edit env.")}</span>
  ) : (
    t("What the service gets at its next deploy.")
  );
  if (files.length === 1) return <ServerEnv env={envOf(files[0]!, 0)} note={note} />;
  // one tab per env file, as the edit form has them
  return (
    <Tabs defaultValue={files[0]} className="space-y-3">
      <TabsList>
        {files.map((file) => (
          <TabsTrigger key={file} value={file} className="font-mono text-xs">
            {file}
          </TabsTrigger>
        ))}
      </TabsList>
      {files.map((file, index) => (
        <TabsContent key={file} value={file}>
          <ServerEnv env={envOf(file, index)} note={note} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

/**
 * An edit dialog's form, on the service as the server has it now: read again
 * each time it opens, and shown once that answer is in — never a copy the page
 * held from before a save.
 */
function Fresh({ appId, children }: { appId: string; children: (application: Application) => React.ReactNode }) {
  const { data: application, isFetchedAfterMount } = useQuery({
    queryKey: ["application", appId],
    queryFn: () => getApplication(appId),
    refetchOnMount: "always",
  });
  if (!application || !isFetchedAfterMount) {
    return <Loader2 className="mx-auto my-8 h-5 w-5 animate-spin text-muted-foreground" />;
  }
  return <>{children(application)}</>;
}

/**
 * One service's deployment settings on the app's Build tab, read: its commands
 * (its own, else what detection found — marked so) and port. The panel's own
 * services are edited in a dialog (Edit); one run by pm2, docker or compose on
 * its server is shown as it runs there; uploaded files are not built.
 */
function ServiceBuildSection({ appId }: { appId: string }) {
  const { data: application } = useApplication(appId);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const detection = useQuery({
    queryKey: ["application", appId, "detect"],
    queryFn: () => getAppDetection(appId),
    enabled: !!application && !application.runtime && !!application.repository,
    staleTime: 5 * 60_000,
    retry: false,
  });
  if (!application) return <Loader2 className="mx-auto my-6 h-5 w-5 animate-spin text-muted-foreground" />;
  const host = application.domains.map((d) => d.host).find(isPublicHost);
  const uploadedSite = application.type === "STATIC" && !application.repository;
  const editable = !uploadedSite && !application.runtime;
  const detected = detection.data;
  // its own setting, else detection's default in grey — what a deploy uses either way
  const value = (own?: string | null, fallback?: string | null) =>
    own ? own : fallback ? <span className="text-muted-foreground" title={t("Detected — used while empty")}>{fallback}</span> : "—";
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 pb-3">
        <CardTitle className="flex min-w-0 items-center gap-2 text-base">
          <Hammer className="h-4 w-4 shrink-0 text-primary" />
          <span className="truncate">{application.name}</span>
          {host && !application.name.includes(host) && <span className="truncate font-mono text-xs font-normal text-muted-foreground">{host}</span>}
        </CardTitle>
        {editable && (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="mr-2 h-3.5 w-3.5" />
            {t("Edit build")}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-1.5 text-sm">
        {uploadedSite ? (
          <p className="text-muted-foreground">{t("Uploaded files are served as they are — nothing is built.")}</p>
        ) : application.runtime === "DOCKER" ? (
          // docker runs it, not the panel: where Caddy sends it and where compose started it are what matter
          <>
            <MiniLine label={t("Proxy target")}>{application.port ? `127.0.0.1:${application.port}` : "—"}</MiniLine>
            <MiniLine label={t("Folder")}>{application.rootPath || t("not started by compose")}</MiniLine>
          </>
        ) : application.runtime ? (
          // run on its server by whoever set it up: shown, not edited here
          <>
            <MiniLine label={t("Build Command")}>{application.buildCommand || "—"}</MiniLine>
            {application.type !== "STATIC" && (
              <MiniLine label={t("Start Command")}>
                {application.runtime === "PM2" && application.processName ? `pm2 restart ${application.processName}` : application.startCommand || "—"}
              </MiniLine>
            )}
          </>
        ) : application.type === "COMPOSE" ? (
          <>
            <MiniLine label={t("Compose files")}>{(application.composeFiles?.length ? application.composeFiles : ["docker-compose.yml"]).join(", ")}</MiniLine>
            <MiniLine label={t("Service")}>{application.composeService || "—"}</MiniLine>
          </>
        ) : (
          <>
            <MiniLine label={t("Package manager")}>{value(application.packageManager, detected?.packageManager ?? t("Automatic"))}</MiniLine>
            <MiniLine label={t("Install Command")}>{value(application.installCommand, detected?.installCommand)}</MiniLine>
            <MiniLine label={t("Build Command")}>{value(application.buildCommand, detected?.buildCommand)}</MiniLine>
            <MiniLine label={t("Pre-deploy Command")}>{value(application.preDeployCommand, detected?.preDeployCommand)}</MiniLine>
            {application.type !== "STATIC" && (
              <>
                <MiniLine label={t("Start Command")}>{value(application.startCommand, detected?.startCommand)}</MiniLine>
              </>
            )}
          </>
        )}
      </CardContent>
      <Dialog
        open={editing}
        onOpenChange={(open) => {
          setEditing(open);
          if (!open) void queryClient.invalidateQueries({ queryKey: ["application", appId] });
        }}
      >
        <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col overflow-auto">
          <DialogHeader>
            <DialogTitle>
              {t("Build Settings")} — {application.name}
            </DialogTitle>
          </DialogHeader>
          {editing && <Fresh appId={appId}>{(fresh) => <ApplicationSettingsForm application={fresh} detected={detected} />}</Fresh>}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

/**
 * One more service from the app's repository: its folder (a monorepo's apps/web;
 * empty = the root), the type and commands detected from it, a name. Its hosts
 * and env come after, from the checklist above the rows — then its first deploy.
 */
function QuickAddService({ projectId, open, onOpenChange }: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const createApp = useCreateApplication();
  const [folder, setFolder] = useState("");
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);
  // read once typing pauses: every read clones the repository
  const [asked, setAsked] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setAsked(folder.trim().replace(/^\/+|\/+$/g, "")), 600);
    return () => clearTimeout(timer);
  }, [folder]);
  const detection = useQuery({
    queryKey: ["detect-folder", projectId, asked],
    queryFn: () => detectProject({ sourceId: projectId, rootDirectory: asked || undefined }),
    enabled: open,
    retry: false,
    staleTime: 5 * 60_000,
  });
  // named after its folder until someone types a name
  const suggested = slugify(asked.split("/").pop() || "") || "web";
  const finalName = named ? name : suggested;
  const reset = () => {
    setFolder("");
    setAsked("");
    setName("");
    setNamed(false);
  };
  const detected = detection.data;
  const ready = !!detected && !detection.isFetching && asked === folder.trim().replace(/^\/+|\/+$/g, "") && !!finalName.trim();
  const add = async () => {
    if (!detected) return;
    try {
      await createApp.mutateAsync({
        name: finalName.trim(),
        type: detected.type,
        rootDirectory: asked || undefined,
        sourceId: projectId,
        // Prisma's migrations: the tables have to exist before the release goes live
        preDeployCommand: (detected.type !== "STATIC" && detected.preDeployCommand) || undefined,
      });
    } catch {
      return; // createApp says why
    }
    void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    reset();
    onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Add service")}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) void add();
          }}
        >
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("Folder in the repository")}</label>
            <Input autoFocus value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="apps/web" className="font-mono" />
            <p className="text-xs text-muted-foreground">{t("Empty = the repository's root.")}</p>
          </div>
          {/* what it is, read from that folder */}
          <p className="flex min-h-5 items-center gap-1.5 text-sm">
            {detection.isFetching || asked !== folder.trim().replace(/^\/+|\/+$/g, "") ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                <span className="text-muted-foreground">{t("Reading the folder…")}</span>
              </>
            ) : detection.error ? (
              <span className="text-destructive">{(detection.error as Error).message}</span>
            ) : detected ? (
              <>
                <AppTypeBadge type={detected.type} />
                <span className="text-muted-foreground">{detected.label}</span>
              </>
            ) : null}
          </p>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t("Name")}</label>
            <Input
              value={finalName}
              onChange={(e) => {
                setNamed(true);
                setName(slugify(e.target.value));
              }}
              className="font-mono"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={!ready || createApp.isPending}>
              {createApp.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("Add")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A compose service's stack, as `compose config` reads its files on the node:
 * each of its services, image, ports, what it depends on. Picking one makes it
 * the one the domain points at — saved, used at the next deploy.
 */
function StackSection({ app }: { app: ProjectApp }) {
  const { data: application } = useApplication(app.id);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const pick = useMutation({
    mutationFn: ({ service, port }: { service: string; port: string }) =>
      updateApplication(app.id, { composeService: service, ...(port && { composePort: Number(port) }) }),
    onSuccess: (_, { service }) => {
      void queryClient.invalidateQueries({ queryKey: ["application", app.id] });
      toast({ title: t("Saved"), description: t("{service} serves the domain from the next deploy.", { service }) });
    },
    onError: (error: Error) => toast({ variant: "destructive", title: t("Could not save"), description: error.message }),
  });
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Layers className="h-4 w-4 text-primary" />
          {app.name}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ComposePreview
          applicationId={app.id}
          selected={application?.composeService ?? ""}
          onPick={(service, port) => pick.mutate({ service, port })}
        />
      </CardContent>
    </Card>
  );
}

/** The app's deploy history: the history is its source's, read through any of its services. */
function AppDeployments({ appId, showApp }: { appId: string; showApp: boolean }) {
  const { data: application } = useApplication(appId);
  if (!application) return <Loader2 className="mx-auto my-6 h-5 w-5 animate-spin text-muted-foreground" />;
  return <DeploymentHistory application={application} showApp={showApp} />;
}

/** Label left, value right — a line of read-only settings. */
function MiniLine({ label, children, mono = true }: { label: string; children: React.ReactNode; /** commands: monospace */ mono?: boolean }) {
  return (
    <p className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={`min-w-0 text-right ${mono ? "break-all font-mono" : ""}`}>{children}</span>
    </p>
  );
}

