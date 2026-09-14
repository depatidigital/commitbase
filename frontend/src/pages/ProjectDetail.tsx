import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, HardDrive, Layers, Loader2, MoreHorizontal, Plus, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
import { deleteApplication, hostList, hostsOf, isPublicHost, repoName } from "@/lib/applications";
import { appStatus, getApplicationHealth, type Health } from "@/lib/health";
import { isAdmin, isSuperAdmin } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { appParts, getProject } from "@/lib/projects";

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
          {isAdmin() && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label={t("More actions")}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
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
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      }
    >
      {/* the apps: pick one, the rest of the page is about it */}
      {apps.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {apps.map((app) => {
            const parts = appParts(app);
            const type = APP_TYPES[app.type] ?? { label: app.type.toLowerCase(), icon: Layers, className: "text-muted-foreground" };
            const TypeIcon = type.icon;
            const active = app.id === picked?.id;
            return (
              <button
                key={app.id}
                type="button"
                onClick={() => setSearchParams({ app: app.id }, { replace: true })}
                className={`flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  active ? "border-primary bg-primary/5" : "border-border/60 hover:border-primary/40"
                } ${app.disabled ? "opacity-50" : ""}`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[statusOf(app.id).tone]}`} title={statusOf(app.id).text} />
                <TypeIcon className={`h-3.5 w-3.5 shrink-0 ${type.className}`} />
                <span className="min-w-0">
                  <span className="block truncate font-medium" title={hostList(app)}>
                    {/* every name it answers on, none first */}
                    {app.domains.every((d) => !isPublicHost(d.host)) ? app.name : hostList(app)}
                  </span>
                  {/* a hostname split by path: its other parts */}
                  {parts.length > 1 && (
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {parts.filter((part) => !part.main).map((part) => part.label.slice(hostsOf(app)[0]?.length ?? 0)).join(" · ")}
                    </span>
                  )}
                  {!imported && app.rootDirectory && (
                    <span className="block truncate font-mono text-xs text-muted-foreground">{app.rootDirectory}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {picked ? (
        <AppWorkspace key={picked.id} appId={picked.id} embedded />
      ) : (
        <p className="text-muted-foreground">{t("No apps")}</p>
      )}

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
