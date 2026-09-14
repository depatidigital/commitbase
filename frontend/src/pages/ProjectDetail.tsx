import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, FolderGit2, Layers, Loader2, Plus, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageLayout } from "@/components/PageLayout";
import { SourcePanel } from "@/components/SourcePanel";
import DeploymentHistory from "@/components/DeploymentHistory";
import { TYPES as APP_TYPES } from "@/components/AppTypeBadge";
import { useToast } from "@/hooks/use-toast";
import { getApplication, runtimeLabel } from "@/lib/applications";
import { isSuperAdmin } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { deployProject, getProject, PROJECT_STATUS } from "@/lib/projects";

const APP_DOT: Record<string, string> = {
  RUNNING: "bg-success",
  ERROR: "bg-destructive",
  STOPPED: "bg-muted-foreground/40",
  DEPLOYING: "bg-warning animate-pulse",
  BUILDING: "bg-warning animate-pulse",
};

/**
 * A project ("Proyek") with several apps ("Aplikasi"): a monorepo's, or the
 * sites one checkout serves. Pulling and deploying are here, once for all of
 * them; each app's own page keeps what is per hostname.
 */
export default function ProjectDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const superAdmin = isSuperAdmin();

  const { data: project, isLoading, error } = useQuery({
    queryKey: ["project", id],
    queryFn: () => getProject(id),
    refetchInterval: (q) => (q.state.data?.status === "DEPLOYING" ? 3_000 : 20_000),
  });
  // the history is the project's, read through any of its apps
  const first = project?.applications[0];
  const { data: firstApp } = useQuery({
    queryKey: ["application", first?.id],
    queryFn: () => getApplication(first!.id),
    enabled: !!first,
  });

  const deploy = useMutation({
    mutationFn: () => deployProject(id),
    onSuccess: () => {
      toast({ title: t("Deployment started"), description: t("Every app of the project is built from the same commit.") });
      void queryClient.invalidateQueries({ queryKey: ["project", id] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["deployments"] });
    },
    onError: (err: Error) => toast({ title: t("Could not start the deployment"), description: err.message, variant: "destructive" }),
  });

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

  const managed = project.kind === "MANAGED";
  const status = PROJECT_STATUS[project.status] ?? PROJECT_STATUS.STOPPED;
  const deploying = project.status === "DEPLOYING";

  return (
    <PageLayout
      title={project.name}
      backTo="/"
      icon={FolderGit2}
      description={status.text}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {managed && (
            <>
              <Button variant="outline" asChild>
                <Link to={`/add-app?project=${project.id}`}>
                  <Plus className="mr-2 h-4 w-4" />
                  {t("Add app")}
                </Link>
              </Button>
              <Button className="bg-gradient-primary" disabled={deploy.isPending || deploying} onClick={() => deploy.mutate()}>
                {deploy.isPending || deploying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Rocket className="mr-2 h-4 w-4" />}
                {deploying ? t("Deploying…") : t("Deploy all")}
              </Button>
            </>
          )}
        </div>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          <Card className="bg-gradient-card border-border/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Layers className="h-4 w-4" />
                {t("Apps")}
                <span className="text-sm font-normal text-muted-foreground">{project.applications.length}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="divide-y divide-border/60 p-0">
              {project.applications.map((app) => {
                const type = APP_TYPES[app.type] ?? { label: app.type.toLowerCase(), icon: Layers, className: "text-muted-foreground" };
                const TypeIcon = type.icon;
                const internal = app.domain.endsWith(".local");
                return (
                  <button
                    key={app.id}
                    type="button"
                    onClick={() => navigate(`/application/${app.id}`)}
                    className={`flex w-full items-center gap-3 px-6 py-3 text-left hover:bg-muted/50 ${app.disabled ? "opacity-50" : ""}`}
                  >
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${APP_DOT[app.status] ?? "bg-muted-foreground/40"}`} title={app.status} />
                    <span className="flex w-20 shrink-0 items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs font-medium">
                      <TypeIcon className={`h-3.5 w-3.5 shrink-0 ${type.className}`} />
                      <span className="truncate">{type.label}</span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{internal ? app.name : app.domain}</span>
                      {/* what tells the apps apart: their folder, or what runs them */}
                      <span className="block truncate text-xs text-muted-foreground">
                        {[app.rootDirectory, superAdmin && app.runtime && `${runtimeLabel(app.runtime)}${app.processName ? ` · ${app.processName}` : ""}`, superAdmin && app.rootPath]
                          .filter(Boolean)
                          .join(" · ") || t("Repository root")}
                      </span>
                    </span>
                    {!internal && (
                      <a
                        href={`https://${app.domain}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => event.stopPropagation()}
                        className="shrink-0 text-muted-foreground hover:text-primary"
                        aria-label={t("Open {url}", { url: app.domain })}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </button>
                );
              })}
            </CardContent>
          </Card>

          {firstApp && <DeploymentHistory application={firstApp} />}
        </div>

        <aside className="space-y-4">
          {project.repository && (
            <SourcePanel projectId={project.id} onDeploy={() => deploy.mutate()} starting={deploy.isPending} deploying={deploying} />
          )}
          <Card className="bg-gradient-card border-border/50">
            <CardContent className="space-y-2 p-4 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{t("Organization")}</span>
                {project.organization ? <Badge variant="outline">{project.organization.name}</Badge> : <span>{t("Unassigned")}</span>}
              </div>
              {project.server && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">{t("Server")}</span>
                  {superAdmin ? (
                    <Link to={`/servers/${project.server.id}`} className="hover:underline">
                      {project.server.name}
                    </Link>
                  ) : (
                    <span>{project.server.name}</span>
                  )}
                </div>
              )}
              {project.path && superAdmin && (
                <div className="space-y-1">
                  <span className="text-muted-foreground">{t("Folder on the server")}</span>
                  <p className="break-all font-mono text-xs">{project.path}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </PageLayout>
  );
}
