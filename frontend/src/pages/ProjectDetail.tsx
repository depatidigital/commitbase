import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle, ChevronDown, ChevronRight, FolderOpen, GitBranch, Hammer, HardDrive, KeyRound, Loader2, Pencil, Play, Rocket, Plus, RefreshCw, Route, Server, Square, Trash2, Upload } from "lucide-react";
import { RoutingCard } from "@/components/RoutingCard";
import { ServerEnv } from "@/components/ServerEnv";
import { AppEnvironment } from "@/components/AppEnvironment";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useApplication, useRestartApplication, useStartApplication, useStartExistingApplication, useStopApplication } from "@/hooks/useApplications";
import { AppSetupCard } from "@/components/AppSetupCard";
import { envWarnings, requiredKeys } from "@/lib/env";
import { stripAnsi } from "@/lib/ansi";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import DeploymentHistory, { deploymentStatusLabel } from "@/components/DeploymentHistory";
import { AppDatabasesTab } from "@/components/AppDatabasesTab";
import { ProjectLogs } from "@/components/ProjectLogs";
import { AppStorageCard } from "@/components/AppStorageCard";
import { SourcePanel } from "@/components/SourcePanel";
import { PageLayout } from "@/components/PageLayout";
import { RenameProjectDialog } from "@/components/RenameProjectDialog";
import { AppTypeBadge } from "@/components/AppTypeBadge";
import { AppWorkspace, Field } from "./ApplicationDetail";
import { useToast } from "@/hooks/use-toast";
import { type Application, bindingLabel, deleteApplication, getAppDetection, getSiteFiles, hasBeenDeployed, hostList, repoName, runtimeLabel } from "@/lib/applications";
import { SiteFilesCard } from "@/components/SiteFilesCard";
import { formatBytes } from "@/lib/utils";
import { appStatus, getApplicationHealth, type Health } from "@/lib/health";
import { isSuperAdmin } from "@/lib/auth";
import { locale, t } from "@/lib/i18n";
import { buildProject, deployProject, getProject } from "@/lib/projects";

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
 * list for a quick edit, or a level deeper (?app=) with its own header and
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
    refetchInterval: (q) => (q.state.data?.status === "DEPLOYING" ? 3_000 : 20_000),
  });
  const appIds = project?.applications.map((app) => app.id) ?? [];
  const { data: healthById = {} } = useQuery({
    queryKey: ["applications", "health", appIds],
    queryFn: () => getApplicationHealth(appIds),
    enabled: appIds.length > 0,
    refetchInterval: 60_000,
  });

  // delete the project = delete every app of it, one after the other
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  // build every imported app where it lives — asked first, with a tick
  const [confirmBuild, setConfirmBuild] = useState(false);
  const [buildConsent, setBuildConsent] = useState(false);
  const [building, setBuilding] = useState(false);
  // the app cards flipped from how they start (open until the project's first deploy, closed after)
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const toggle = (appId: string) =>
    setToggled((open) => {
      const next = new Set(open);
      if (!next.delete(appId)) next.add(appId);
      return next;
    });
  // where the opened app's actions render: its header's right side
  const [panelSlot, setPanelSlot] = useState<HTMLDivElement | null>(null);
  // a panel-managed project deploys as one, from its source panel
  const deploy = useMutation({
    mutationFn: () => deployProject(id),
    onSuccess: () => {
      toast({ title: t("Deploying") });
      void queryClient.invalidateQueries({ queryKey: ["project", id] });
      void queryClient.invalidateQueries({ queryKey: ["deployments"] });
      void queryClient.invalidateQueries({ queryKey: ["application"] });
    },
    onError: (error: Error) => toast({ variant: "destructive", title: t("Could not start the deployment"), description: error.message }),
  });
  // the project's tab (?tab=), or one of its apps opened a level deeper (?app=)
  const tab = ["logs", "deployments", "database", "storage", "settings"].includes(searchParams.get("tab") ?? "") ? searchParams.get("tab")! : "apps";
  const go = (next: string) => setSearchParams(next === "apps" ? {} : { tab: next }, { replace: true });
  // a step into the app: the browser's back comes out again
  const openApp = (appId: string) => setSearchParams({ app: appId });
  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (error || !project) {
    return <p className="p-6 text-destructive">{(error as Error | null)?.message ?? t("Project not found")}</p>;
  }

  const apps = project.applications;
  const opened = apps.find((app) => app.id === searchParams.get("app"));
  // a level deeper: the app's own header and page instead of the project's header and tabs
  const appView = opened;
  const statusOf = (appId: string) => {
    const app = apps.find((a) => a.id === appId)!;
    return appStatus(app.status, healthById[app.id] as Health | undefined, app.disabled);
  };
  const live = apps.filter((app) => !app.disabled);
  const online = live.filter((app) => statusOf(app.id).tone === "up").length;
  const imported = project.kind === "IMPORTED";
  // releases and a build cache on its node: the panel's own projects, but for static sites (their files are in R2)
  const hasStorage = !imported && !!apps[0] && !apps.every((app) => app.type === "STATIC");
  // never deployed: every card starts open on its setup checklist — env, then deploy
  const startsOpen = !imported && !project.lastDeployment && !project.activeRelease;
  const isOpen = (appId: string) => toggled.has(appId) !== startsOpen;

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
        await deleteApplication(app.id);
      } catch (err) {
        setDeleting(null);
        setConfirmDelete(false);
        void queryClient.invalidateQueries({ queryKey: ["project", id] });
        toast({
          variant: "destructive",
          title: t("Stopped at {app}", { app: app.name }),
          description: `${(err as Error).message} — ${t("the apps before it are deleted, the rest are kept.")}`,
        });
        return;
      }
    }
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
    void queryClient.invalidateQueries({ queryKey: ["applications"] });
    toast({ title: t("Project deleted"), description: t("{count} apps deleted", { count: apps.length }) });
    navigate("/");
  };

  return (
    <PageLayout
      backTo={appView ? `/project/${project.id}` : "/"}
      title={
        appView ? (
          <span className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[statusOf(appView.id).tone]}`} title={statusOf(appView.id).text} />
            {appView.name}
          </span>
        ) : (
          <span className="flex items-center gap-2">
            {project.name}
            <RenameProjectDialog project={project} />
          </span>
        )
      }
      description={
        appView ? (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-muted-foreground">
            <Link to={`/project/${project.id}`} className="hover:text-primary hover:underline">
              {project.name}
            </Link>
            <span>›</span>
            <span>{appView.name}</span>
          </span>
        ) : (
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1.5">{origin}</span>
          {project.organization && <Badge variant="outline">{project.organization.name}</Badge>}
          {project.server &&
            (superAdmin ? (
              <Link to={`/servers/${project.server.id}`} className="text-xs hover:underline">
                {project.server.name}
              </Link>
            ) : (
              <span className="text-xs">{project.server.name}</span>
            ))}
        </span>
        )
      }
      actions={
        // an app: its own actions (start, stop, build, visit — AppWorkspace portals them here).
        // The project: how it stands and building it all are in its status card, deleting it in its Settings tab
        appView ? (
          <div ref={setPanelSlot} className="flex flex-wrap items-center gap-2" />
        ) : !imported && (
          <Button variant="outline" asChild>
            <Link to={`/project/${project.id}/add-app`}>
              <Plus className="mr-2 h-4 w-4" />
              {t("Add app")}
            </Link>
          </Button>
        )
      }
    >
      {/* the tabs with the project's panel beside them — or one app, a level deeper, with its own.
          The same for a project of one app as of many */}
      <div className={appView ? "" : "grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]"}>
      {appView ? (
        // rendered once the header's slot is there, so its actions go straight into it
        <div>
          {panelSlot && <AppWorkspace key={appView.id} appId={appView.id} embedded onProjectTab={(next) => go(next)} panelSlot={panelSlot} />}
        </div>
      ) : (
      <Tabs value={tab} onValueChange={(next) => go(next)} className="min-w-0 space-y-6">
        <TabsList>
          <TabsTrigger value="apps">{t("Apps")}</TabsTrigger>
          <TabsTrigger value="logs">{t("Logs")}</TabsTrigger>
          <TabsTrigger value="deployments">{t("Deployments")}</TabsTrigger>
          <TabsTrigger value="database">{t("Database")}</TabsTrigger>
          {hasStorage && <TabsTrigger value="storage">{t("Storage")}</TabsTrigger>}
          <TabsTrigger value="settings">{t("Settings")}</TabsTrigger>
        </TabsList>

        {/* its apps and their routes — an app has many (host, host/path), a route belongs to one app.
            A card opens that app a level deeper */}
        <TabsContent value="apps">
          {apps.length === 0 && <p className="py-8 text-center text-muted-foreground">{t("No apps")}</p>}
          <ul className="space-y-2">
            {apps.map((app) => {
              // what serves it on the box — its pm2 process, Caddy's files or proxy — as the projects list says it
              const runtime = `${runtimeLabel(app.runtime)}${app.runtime === "PM2" && app.processName ? ` · ${app.processName}` : ""}`;
              const bindings = [...app.domains].sort((a, b) => a.host.localeCompare(b.host) || (a.path ?? "").localeCompare(b.path ?? ""));
              return (
                <li key={app.id} className={`rounded-lg border border-border/60 bg-card transition-colors hover:border-primary/40 ${app.disabled ? "opacity-50" : ""}`}>
                  <div className="flex items-stretch">
                  {/* the row opens it here for a quick edit — its hosts and actions — without leaving the list */}
                  <button
                    type="button"
                    aria-expanded={isOpen(app.id)}
                    onClick={() => toggle(app.id)}
                    className="flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-3 rounded-l-lg py-4 pl-3 pr-4 text-left transition-colors hover:bg-muted/30"
                  >
                    <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isOpen(app.id) ? "" : "-rotate-90"}`} />
                    <span className="min-w-0 space-y-1.5 sm:w-72">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[statusOf(app.id).tone]}`} title={statusOf(app.id).text} />
                        <span className="truncate font-medium">{app.name}</span>
                      </span>
                      <span className="flex flex-wrap items-center gap-2">
                        <AppTypeBadge type={app.type} />
                        {/* only what is not the panel's own: an imported app's pm2 process or Caddy files */}
                        {app.runtime && (
                          <Badge variant="outline" className="truncate border-warning/50 px-1.5 py-0 text-[10px] font-medium text-warning" title={app.rootPath ?? undefined}>
                            {runtime}
                          </Badge>
                        )}
                      </span>
                    </span>
                    {/* where visitors reach it — opened, the quick edit below lists them instead */}
                    <span className={`min-w-0 flex-1 items-start gap-1.5 font-mono text-xs ${isOpen(app.id) ? "hidden" : "flex"}`}>
                      <Route className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                      {bindings.length === 0 ? (
                        <span className="text-muted-foreground">{t("no route")}</span>
                      ) : (
                        // one line, comma-separated, wrapping as it must
                        <span className="min-w-0 break-words">
                          {bindings.map((d, i) => (
                            <span key={bindingLabel(d)}>
                              {d.host}
                              {d.path && <span className="text-muted-foreground">{d.path}</span>}
                              {i < bindings.length - 1 && <span className="text-muted-foreground">, </span>}
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                  </button>
                  {/* its whole page, a level deeper */}
                  <button
                    type="button"
                    aria-label={t("Open details")}
                    title={t("Open details")}
                    onClick={() => openApp(app.id)}
                    className="group flex shrink-0 items-center rounded-r-lg border-l border-border/60 px-4 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                  >
                    <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </button>
                  </div>
                  {isOpen(app.id) && <AppQuickEdit appId={app.id} onOpen={() => openApp(app.id)} />}
                </li>
              );
            })}
          </ul>
        </TabsContent>

        {/* every app's log in one live stream, or one app's — followed only while this tab is open */}
        <TabsContent value="logs">
          <ProjectLogs projectId={project.id} apps={apps} />
        </TabsContent>

        {/* one history for the project: a deploy builds every app of it */}
        <TabsContent value="deployments">
          {apps[0] && (
            <DeploymentHistory application={{ id: apps[0].id, type: apps[0].type as Application["type"], repository: project.repository ?? undefined }} showApp />
          )}
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
            <AppStorageCard appId={apps[0].id} deploying={project.status === "DEPLOYING"} />
          </TabsContent>
        )}

        {/* as the API allows it: the panel's own apps, anyone who manages them; apps set up on the server, a superadmin only */}
        <TabsContent value="settings" className="space-y-6">
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
                  <p className="font-medium">{t("Delete this project")}</p>
                  <p className="text-muted-foreground">
                    {t("Every app of it is deleted too ({count}): {apps}.", { count: apps.length, apps: apps.map((app) => app.name).join(", ") })}{" "}
                    {imported
                      ? t("They were set up on the server: their process, Caddy route, DNS record and folder are removed from it too.")
                      : t("This cannot be undone.")}
                  </p>
                  {imported && !superAdmin && (
                    <p className="mt-1 text-xs text-muted-foreground">{t("Only a superadmin can remove things from the server.")}</p>
                  )}
                </div>
                <Button
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  disabled={imported && !superAdmin}
                  onClick={() => {
                    setTyped("");
                    setConfirmDelete(true);
                  }}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t("Delete project")}
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
      )}

      {/* where its code comes from and where it lives — the project's, shared by every app of it;
          a pull, a branch switch or a deploy changes them all */}
      {!appView && (
      <aside className="space-y-4 lg:sticky lg:top-4">
        {/* the project's state: how many of its apps answer, each one's, and what can be done to them all */}
        <Card className={`bg-gradient-card ${online < live.length ? "border-destructive/40" : "border-border/50"}`}>
          <CardContent className="space-y-4 p-4">
            <div className="flex items-start gap-3">
              {online < live.length ? (
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
              ) : (
                <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-success" />
              )}
              <div className="min-w-0">
                <h3 className="font-semibold">{online < live.length ? t("{count} down", { count: live.length - online }) : t("All online")}</h3>
                <p className="text-sm text-muted-foreground">{t("{online} of {total} online", { online, total: live.length })}</p>
              </div>
            </div>
            <ul className="space-y-1">
              {apps.map((app) => (
                <li key={app.id}>
                  <button
                    type="button"
                    onClick={() => openApp(app.id)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted/50 ${
                      app.id === opened?.id ? "bg-muted/50 font-medium" : ""
                    } ${app.disabled ? "opacity-50" : ""}`}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[statusOf(app.id).tone]}`} />
                    <span className="min-w-0 flex-1 truncate">{app.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{statusOf(app.id).text}</span>
                  </button>
                </li>
              ))}
            </ul>
            {project.lastDeployment && (
              <p className="text-xs text-muted-foreground">
                {t("Last Deployment")}: {new Date(project.lastDeployment.createdAt).toLocaleString(locale)} · {deploymentStatusLabel(project.lastDeployment.status)}
              </p>
            )}
            {/* imported: every app built where it lives — the sites' files, then the processes */}
            {imported && project.canSwitchBranch && (
              <Button variant="outline" className="w-full" onClick={() => setConfirmBuild(true)}>
                <Hammer className="mr-2 h-4 w-4" />
                {t("Redeploy")}
              </Button>
            )}
          </CardContent>
        </Card>
        {project.repository && (
          <SourcePanel
            projectId={project.id}
            onDeploy={() => deploy.mutate()}
            starting={deploy.isPending}
            deploying={project.status === "DEPLOYING"}
          />
        )}
        <div className="rounded-lg border border-border/60 bg-card px-4 py-2">
          {!project.repository && (
            <Field label={t("Source")}>
              <span className="inline-flex items-center gap-1.5">{origin}</span>
            </Field>
          )}
          <Field label={t("Server")}>
            {project.server ? (
              <span className="inline-flex flex-wrap items-center justify-end gap-x-2">
                <Server className="h-4 w-4 text-muted-foreground" />
                {superAdmin ? (
                  <Link to={`/servers/${project.server.id}`} className="hover:text-primary">
                    {project.server.name}
                  </Link>
                ) : (
                  project.server.name
                )}
                {project.server.publicIp && <span className="w-full font-mono text-xs text-muted-foreground">{project.server.publicIp}</span>}
              </span>
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
        </div>
      </aside>
      )}
      </div>

      <AlertDialog
        open={confirmBuild}
        onOpenChange={(open) => {
          setConfirmBuild(open);
          setBuildConsent(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Redeploy every app of {name}?", { name: project.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("Each app is installed and built in its folder on the server, one after the other: the sites' files first, then the processes, which pm2 restarts. They build in the folders that are serving, so the sites may show errors meanwhile.")}
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
                  toast({ title: t("Building {count} apps", { count: built.length }), description: built.join(", ") });
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
                <p>{t("Every app of this project is deleted, one after the other:")}</p>
                <ul className="list-disc pl-5 font-mono text-xs">
                  {apps.map((app) => (
                    <li key={app.id}>{hostList(app)}</li>
                  ))}
                </ul>
                {imported && (
                  <p className="font-medium text-destructive">
                    {t("They were set up on the server: their process, Caddy route, DNS record and folder are removed from it too.")}
                  </p>
                )}
                <p>{t("Type the project's name to confirm.")}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={project.name} disabled={!!deleting} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!deleting}>{t("Cancel")}</AlertDialogCancel>
            <Button variant="destructive" disabled={typed.trim() !== project.name || !!deleting} onClick={() => void deleteAll()}>
              {deleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("Deleting {app}…", { app: deleting })}
                </>
              ) : (
                t("Delete project")
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageLayout>
  );
}

/**
 * An app card opened in the list, for a quick edit without leaving it: its
 * hosts (each opens in a new tab; edited in their dialog) and what its state
 * allows — Stop and Restart while it runs, Start when it is stopped. The rest
 * is on its page — the card's › button.
 */
function AppQuickEdit({ appId, onOpen }: { appId: string; /** its whole page — where its build settings are edited */ onOpen: () => void }) {
  const { data: application, isLoading } = useApplication(appId);
  const start = useStartExistingApplication();
  const firstDeploy = useStartApplication();
  const queryClient = useQueryClient();
  const stop = useStopApplication();
  const restart = useRestartApplication();
  const [confirmStop, setConfirmStop] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  // never deployed, and ours to deploy: its setup checklist, as on its page
  const needsSetup =
    !!application && !(application.type === "STATIC" && !application.repository) && !application.runtime && !hasBeenDeployed(application);
  // the same query (and cache) as its page's checklist
  const detection = useQuery({
    queryKey: ["application", appId, "detect"],
    queryFn: () => getAppDetection(appId),
    enabled: needsSetup,
    staleTime: 5 * 60_000,
    retry: false,
  });
  if (isLoading || !application) {
    return (
      <div className="border-t border-border/60 p-4">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  // a process the panel or pm2 starts and stops — not a PHP site or static files, nor someone else's.
  // Started again from its built release: one never deployed is deployed from its page
  const controllable =
    (!application.runtime || application.runtime === "PM2") && !["STATIC", "PHP"].includes(application.type) && (!!application.runtime || hasBeenDeployed(application));
  const running = application.status === "RUNNING";
  const pending = start.isPending || stop.isPending || restart.isPending;
  const env = Object.keys(application.envVars ?? {});
  const lastDeployment = application.deployments?.[0];
  // a site uploaded as files: nothing is built or run, and it is given no env — its files are what there is
  const uploadedSite = application.type === "STATIC" && !application.repository;
  // counted from the saved env: the form is in the Env dialog, saved before it closes
  // before its first save every expected key counts; after it, only those it kept (a removed one is not used)
  const missing = [...requiredKeys(detection.data)].filter((key) =>
    application.envConfirmed === false ? !application.envVars?.[key]?.trim() : application.envVars?.[key] !== undefined && !application.envVars[key].trim(),
  );
  // filled but likely wrong on the server (localhost…) — the same the Env dialog flags
  const warnings = envWarnings(Object.entries(application.envVars ?? {}).map(([key, value]) => ({ key, value })));
  const lastFailed =
    lastDeployment?.status === "FAILED"
      ? stripAnsi(lastDeployment.deployLogs || lastDeployment.buildLogs?.trim().split("\n").slice(-3).join("\n") || "")
      : "";
  return (
    <div className="space-y-3 border-t border-border/60 p-4">
      {/* bento: its hosts and how it is built and run side by side; under them what it is given,
          the full width, beside the actions — read at a glance, hosts managed here.
          Never deployed: its setup checklist beside its hosts, and nothing else — the checklist has the env and the build */}
      <div className="grid items-stretch gap-3 md:grid-cols-2">
        <RoutingCard application={application} compact />
        {needsSetup ? (
          <AppSetupCard
            compact
            application={application}
            detected={detection.data}
            detecting={detection.isLoading}
            env={{ missing, warnings, dirty: false }}
            failure={lastFailed || undefined}
            starting={firstDeploy.isPending || ["DEPLOYING", "BUILDING"].includes(application.status)}
            onDeploy={() => firstDeploy.mutate(application.id)}
            onEditEnv={() => setEnvOpen(true)}
            onEditBuild={onOpen}
          />
        ) : (
        <MiniCard icon={Rocket} title={t("Deployments")}>
          {!uploadedSite && (
            <>
              <MiniLine label={t("Build Command")}>{application.buildCommand || "—"}</MiniLine>
              {application.type !== "STATIC" && (
                <MiniLine label={t("Start Command")}>
                  {application.runtime === "PM2" && application.processName ? `pm2 restart ${application.processName}` : application.startCommand || "—"}
                </MiniLine>
              )}
            </>
          )}
          <MiniLine label={t("Last Deployment")} mono={false}>
            {lastDeployment
              ? `${new Date(lastDeployment.createdAt).toLocaleString(locale)} · ${deploymentStatusLabel(lastDeployment.status)}`
              : t("Never deployed")}
          </MiniLine>
        </MiniCard>
        )}
      </div>
      {/* the panel's own apps: the env form. An imported one's is its .env on the server — read, searched, not edited */}
      <Dialog
        open={envOpen}
        onOpenChange={(open) => {
          setEnvOpen(open);
          // closed: read it again, so the card and its checklist show what is saved now
          if (!open) void queryClient.invalidateQueries({ queryKey: ["application", appId] });
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-auto">
          <DialogHeader>
            <DialogTitle>{t("Env")} — {application.name}</DialogTitle>
          </DialogHeader>
          {application.runtime ? (
            <ServerEnv env={application.envVars ?? {}} dir={application.rootPath} />
          ) : (
            <AppEnvironment application={application} detected={detection.data} />
          )}
        </DialogContent>
      </Dialog>
      {!needsSetup && (
      <div className="flex flex-wrap items-center gap-3 md:flex-nowrap">
        <div className="min-w-0 flex-1">
          {uploadedSite ? (
            <SiteFilesMini appId={application.id} />
          ) : (
          <MiniCard
            icon={KeyRound}
            title={`${t("Env")} (${env.length})`}
            action={
              <Button variant="ghost" size="sm" className="-my-1 h-6 px-2 text-xs" onClick={() => setEnvOpen(true)}>
                <Pencil className="mr-1 h-3 w-3" />
                {t("Manage")}
              </Button>
            }
          >
            {env.length === 0 ? (
              <p className="text-muted-foreground">{t("No environment variables configured")}</p>
            ) : (
              // names only, two lines at most — values can be secrets; all of them in Manage
              <p className="line-clamp-2 break-all font-mono" title={env.join(", ")}>
                {env.join(", ")}
              </p>
            )}
          </MiniCard>
          )}
        </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-2 empty:hidden">
      {controllable &&
        (running ? (
          <>
            <Button variant="outline" size="sm" disabled={pending} onClick={() => restart.mutate(application.id)}>
              <RefreshCw className={`mr-2 h-3.5 w-3.5 ${restart.isPending ? "animate-spin" : ""}`} />
              {t("Restart")}
            </Button>
            <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" disabled={pending} onClick={() => setConfirmStop(true)}>
              <Square className="mr-2 h-3.5 w-3.5" />
              {t("Stop")}
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={pending} onClick={() => start.mutate(application.id)}>
            {start.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-2 h-3.5 w-3.5" />}
            {t("Start")}
          </Button>
        ))}
      </div>
      </div>
      )}
      {/* stopping takes it offline: asked first, as on its page */}
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
            <Button
              variant="destructive"
              onClick={() => {
                stop.mutate(application.id);
                setConfirmStop(false);
              }}
            >
              {t("Stop App")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** A small read-only card of the quick edit's bento. */
function MiniCard({ icon: Icon, title, action, children }: { icon: typeof Rocket; title: string; /** a button beside the title */ action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 font-medium text-muted-foreground">
          <Icon className="h-3.5 w-3.5 text-primary" />
          {title}
        </p>
        {action}
      </div>
      {children}
    </div>
  );
}

/** Label left, value right — a line of a MiniCard. */
function MiniLine({ label, children, mono = true }: { label: string; children: React.ReactNode; /** commands: monospace */ mono?: boolean }) {
  return (
    <p className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={`min-w-0 text-right ${mono ? "break-all font-mono" : ""}`}>{children}</span>
    </p>
  );
}

/** A site uploaded as files, in the quick edit's bento: how many and how big, a few of their names — managed in a dialog. */
function SiteFilesMini({ appId }: { appId: string }) {
  const [open, setOpen] = useState(false);
  // the same list the dialog's card reads — one request between them
  const { data, isLoading } = useQuery({ queryKey: ["site-files", appId], queryFn: () => getSiteFiles(appId) });
  const files = data?.files ?? [];
  const bytes = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
  return (
    <MiniCard
      icon={FolderOpen}
      title={`${t("Site files")}${data ? ` (${files.length} · ${formatBytes(bytes, locale)})` : ""}`}
      action={
        <Button variant="ghost" size="sm" className="-my-1 h-6 px-2 text-xs" onClick={() => setOpen(true)}>
          <Pencil className="mr-1 h-3 w-3" />
          {t("Manage")}
        </Button>
      }
    >
      {isLoading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      ) : files.length === 0 ? (
        <p className="text-muted-foreground">{t("No files uploaded yet")}</p>
      ) : (
        <p className="line-clamp-2 break-all font-mono" title={files.map((file) => file.key).join(", ")}>
          {files.map((file) => file.key).join(", ")}
        </p>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-auto">
          <DialogHeader>
            <DialogTitle>{t("Site files")}</DialogTitle>
          </DialogHeader>
          <SiteFilesCard appId={appId} />
        </DialogContent>
      </Dialog>
    </MiniCard>
  );
}
