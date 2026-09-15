import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Hammer, HardDrive, Layers, Loader2, MoreHorizontal, Plus, Route, Trash2, Upload } from "lucide-react";
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
import { PageLayout } from "@/components/PageLayout";
import { RenameProjectDialog } from "@/components/RenameProjectDialog";
import { TYPES as APP_TYPES } from "@/components/AppTypeBadge";
import { AppWorkspace } from "./ApplicationDetail";
import { useToast } from "@/hooks/use-toast";
import { bindingLabel, deleteApplication, hostList, repoName } from "@/lib/applications";
import { appStatus, getApplicationHealth, type Health } from "@/lib/health";
import { isAdmin, isSuperAdmin } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { buildProject, getProject } from "@/lib/projects";

const DOT: Record<string, string> = {
  up: "bg-success",
  down: "bg-destructive",
  warn: "bg-warning",
  deploying: "bg-warning animate-pulse",
  muted: "bg-muted-foreground/40",
};

/**
 * A project ("Proyek") and its apps ("Aplikasi"), on one page: the project's
 * header — where its code comes from, how many of its apps are up — then the
 * app picked (?app=) with everything that is per app: its state and actions,
 * logs, domains, environment, settings. A project of one app has no picker and
 * reads as that app's page. History, pulling and deploying are the project's.
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
  const picked = apps.find((app) => app.id === searchParams.get("app")) ?? apps[0];
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
      <Tabs value={tab} onValueChange={(next) => go(next)} className="space-y-6">
        <TabsList>
          <TabsTrigger value="overview">{t("Overview")}</TabsTrigger>
          <TabsTrigger value="apps">{t("Apps")}</TabsTrigger>
          <TabsTrigger value="deployments">{t("Deployments")}</TabsTrigger>
        </TabsList>

@@BLOCK@@

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
