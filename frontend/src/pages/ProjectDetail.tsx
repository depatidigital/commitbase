import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Hammer, HardDrive, Layers, Loader2, MoreHorizontal, Plus, Route, Server, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import DeploymentHistory from "@/components/DeploymentHistory";
import { AppDatabasesTab } from "@/components/AppDatabasesTab";
import { SourcePanel } from "@/components/SourcePanel";
import { PageLayout } from "@/components/PageLayout";
import { RenameProjectDialog } from "@/components/RenameProjectDialog";
import { AppTypeBadge } from "@/components/AppTypeBadge";
import { AppWorkspace, Field } from "./ApplicationDetail";
import { useToast } from "@/hooks/use-toast";
import { type Application, bindingLabel, deleteApplication, hostList, repoName, runtimeLabel } from "@/lib/applications";
import { appStatus, getApplicationHealth, type Health } from "@/lib/health";
import { isAdmin, isSuperAdmin } from "@/lib/auth";
import { t } from "@/lib/i18n";
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
 * tabs — its apps and their routes, its history, its databases — beside its
 * source and server. An app opens from the list in place (?app=), with
 * everything that is per app: its state and actions, logs, hosts, environment,
 * settings; "All" goes back. A project of one app reads as that app's page.
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
  // where the picked app's state and actions render: the top of the right panel
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
  // the project's tab (?tab=), and the app opened in its Apps tab (?app=) — kept while another tab is open
  const tab = ["deployments", "database"].includes(searchParams.get("tab") ?? "") ? searchParams.get("tab")! : "apps";
  const go = (next: string) => {
    const app = searchParams.get("app");
    setSearchParams({ ...(next !== "apps" && { tab: next }), ...(app && { app }) }, { replace: true });
  };
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
  const picked = opened ?? apps[0];
  const statusOf = (appId: string) => {
    const app = apps.find((a) => a.id === appId)!;
    return appStatus(app.status, healthById[app.id] as Health | undefined, app.disabled);
  };
  const live = apps.filter((app) => !app.disabled);
  const online = live.filter((app) => statusOf(app.id).tone === "up").length;
  const imported = project.kind === "IMPORTED";

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
      backTo="/"
      title={
        <span className="flex items-center gap-2">
          {project.name}
          <RenameProjectDialog project={project} />
        </span>
      }
      description={
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
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {/* how many of its apps answer — each one's own state is in its card below */}
          <span
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm ${
              online < live.length ? "border-destructive/40 text-destructive" : "text-muted-foreground"
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${online < live.length ? "bg-destructive" : "bg-success"}`} />
            {t("{online} of {total} online", { online, total: live.length })}
          </span>
          {!imported && (
            <Button variant="outline" asChild>
              <Link to={`/add-app?project=${project.id}`}>
                <Plus className="mr-2 h-4 w-4" />
                {t("Add app")}
              </Link>
            </Button>
          )}
          {(isAdmin() || (imported && project.canSwitchBranch)) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label={t("More actions")}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* imported: every app built where it lives — the sites' files, then the processes */}
                {imported && project.canSwitchBranch && (
                  <DropdownMenuItem onClick={() => setConfirmBuild(true)}>
                    <Hammer className="mr-2 h-4 w-4" />
                    {t("Build all apps")}
                  </DropdownMenuItem>
                )}
                {isAdmin() && (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => {
                    setTyped("");
                    setConfirmDelete(true);
                  }}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t("Delete project")}
                </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      }
    >
      {/* one app: the page reads as that app's, its history and source included */}
      {apps.length <= 1 ? (
        picked ? (
          <AppWorkspace key={picked.id} appId={picked.id} embedded />
        ) : (
          <p className="text-muted-foreground">{t("No apps")}</p>
        )
      ) : (
      // the tabs, with the project's source beside them — always in view, whichever tab is open
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Tabs value={tab} onValueChange={(next) => go(next)} className="min-w-0 space-y-6">
        <TabsList>
          <TabsTrigger value="apps">{t("Apps")}</TabsTrigger>
          <TabsTrigger value="deployments">{t("Deployments")}</TabsTrigger>
          <TabsTrigger value="database">{t("Database")}</TabsTrigger>
        </TabsList>

        {/* its apps and their routes — an app has many (host, host/path), a route belongs to one app.
            A row opens that app right here, "All" goes back to the list */}
        {/* kept mounted: an opened app keeps its unsaved edits, and its state in the panel, while another tab is open */}
        <TabsContent value="apps" forceMount className="space-y-4 data-[state=inactive]:hidden">
          {opened ? (
            <>
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbLink asChild>
                      <button type="button" className="flex items-center gap-1.5" onClick={() => setSearchParams({}, { replace: true })}>
                        <Layers className="h-3.5 w-3.5" />
                        {t("All apps")}
                      </button>
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage className="flex items-center gap-1.5">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[statusOf(opened.id).tone]}`} title={statusOf(opened.id).text} />
                      {opened.name}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
              <AppWorkspace key={opened.id} appId={opened.id} embedded onProjectTab={(next) => go(next)} panelSlot={panelSlot} />
            </>
          ) : (
          <div className="rounded-lg border border-border/60 bg-card">
            <p className="flex items-center gap-2 border-b border-border/60 px-4 py-3 text-sm font-medium">
              <Route className="h-4 w-4 text-primary" />
              {t("Apps & routes")}
            </p>
            <ul className="divide-y divide-border/60">
              {apps.map((app) => {
                // what serves it on the box — its pm2 process, Caddy's files or proxy — as the projects list says it
                const runtime = `${runtimeLabel(app.runtime)}${app.runtime === "PM2" && app.processName ? ` · ${app.processName}` : ""}`;
                const bindings = [...app.domains].sort((a, b) => a.host.localeCompare(b.host) || (a.path ?? "").localeCompare(b.path ?? ""));
                return (
                  <li key={app.id}>
                    <button
                      type="button"
                      onClick={() => openApp(app.id)}
                      className={`flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left text-sm transition-colors hover:bg-muted/40 ${
                        app.disabled ? "opacity-50" : ""
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-2 sm:w-40">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[statusOf(app.id).tone]}`} title={statusOf(app.id).text} />
                        <span className="truncate font-medium">{app.name}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2 sm:w-72">
                        <AppTypeBadge type={app.type} />
                        <Badge
                          variant="outline"
                          className={`truncate px-1.5 py-0 text-[10px] font-medium ${app.runtime ? "border-warning/50 text-warning" : ""}`}
                          title={app.rootPath ?? undefined}
                        >
                          {runtime}
                        </Badge>
                      </span>
                      <span className="text-muted-foreground">→</span>
                      <span className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-0.5 font-mono text-xs">
                        {bindings.length === 0 && <span className="text-muted-foreground">{t("no route")}</span>}
                        {bindings.map((d) => (
                          <span key={bindingLabel(d)} className="break-all">
                            {d.host}
                            {d.path && <span className="text-muted-foreground">{d.path}</span>}
                          </span>
                        ))}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          )}
        </TabsContent>

        {/* one history for the project: a deploy builds every app of it */}
        <TabsContent value="deployments">
          <DeploymentHistory application={{ id: apps[0].id, type: apps[0].type as Application["type"], repository: project.repository ?? undefined }} showApp />
        </TabsContent>

        {/* the databases its apps share — connected from each app's Environment */}
        <TabsContent value="database">
          <AppDatabasesTab projectId={project.id} />
        </TabsContent>
      </Tabs>

      {/* where its code comes from and where it lives — the project's, shared by every app of it;
          a pull, a branch switch or a deploy changes them all */}
      <aside className="space-y-4 lg:sticky lg:top-4">
        {/* the opened app's state and actions (AppWorkspace portals them here) */}
        <div ref={setPanelSlot} />
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
      </div>
      )}

      <AlertDialog
        open={confirmBuild}
        onOpenChange={(open) => {
          setConfirmBuild(open);
          setBuildConsent(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Build every app of {name}?", { name: project.name })}</AlertDialogTitle>
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
              {t("Build all apps")}
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
