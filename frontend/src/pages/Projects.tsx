import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowRightLeft, ExternalLink, GitBranch, HardDrive, Layers, Loader2, MoreVertical, Pencil, Plus, RefreshCw, Rocket, RotateCw, Server as ServerIcon, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { OrganizationFilter } from "@/components/OrganizationFilter";
import { OrganizationCombobox } from "@/components/OrganizationCombobox";
import { MigrationChoices } from "@/components/DeployConfirmDialog";
import { TYPES } from "@/components/AppTypeBadge";
import { useToast } from "@/hooks/use-toast";
import { useSyncServerApps } from "@/hooks/useApplications";
import { isSuperAdmin } from "@/lib/auth";
import { locale, t } from "@/lib/i18n";
import { isPublicHost, repoName, restartApplication } from "@/lib/applications";
import { getServers } from "@/lib/servers";
import { assignProjects, deployProject, getProjects, projectPath, type Project } from "@/lib/projects";
import { RenameProjectDialog } from "@/components/RenameProjectDialog";

/** Radix Select cannot hold an empty value, so "no filter" needs a stand-in. */
const ALL = "__all__";

/** Compact relative time — "3d ago". The exact stamp lives in the title. */
const ago = (value: string) => {
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 3600) return t("{n}m ago", { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return t("{n}h ago", { n: Math.floor(seconds / 3600) });
  return t("{n}d ago", { n: Math.floor(seconds / 86400) });
};


/**
 * Beside the name, and only when something is off — health as such is the
 * dashboard's: in flight, or the reason it needs a look.
 */
function ProblemBadge({ project }: { project: Project }) {
  if (project.status === "DEPLOYING")
    return (
      <Badge variant="outline" className="shrink-0 gap-1 border-warning/50 px-1.5 py-0 text-[11px] text-warning">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t("Deploying")}
      </Badge>
    );
  if (project.bucket !== "problem") return null;
  const text =
    project.down ? (project.down > 1 ? t("{count} down", { count: project.down }) : t("Down"))
    : project.lastDeployment?.status === "FAILED" ? t("Deploy failed")
    : t("Error");
  return (
    <Badge variant="destructive" className="shrink-0 px-1.5 py-0 text-[11px]">
      {text}
    </Badge>
  );
}

/**
 * The apps ("Aplikasi"; API: sources), one row each: what it is, where it
 * answers, what changed last — to find one and act on it. Newest first. Whether
 * everything is up is the dashboard's question; a row only flags trouble.
 */
export default function Projects() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const superAdmin = isSuperAdmin();
  const query = useTableQuery(25, { sort: "createdAt", order: "desc" });
  const syncApps = useSyncServerApps();
  const [serverFilter, setServerFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkOrgId, setBulkOrgId] = useState("");
  const [moveTarget, setMoveTarget] = useState<Project | null>(null);
  const [moveOrgId, setMoveOrgId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<Project | null>(null);
  const [deployTarget, setDeployTarget] = useState<Project | null>(null);
  const [skipMigrations, setSkipMigrations] = useState<Set<string>>(new Set());
  const [restartTarget, setRestartTarget] = useState<Project | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["projects", query.params, serverFilter],
    queryFn: () => getProjects({ ...query.params, serverId: serverFilter }),
    // statuses move during deploys and syncs
    refetchInterval: 15_000,
  });
  const projects = data?.data ?? [];
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["projects"] });

  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: getServers, enabled: superAdmin });

  const assign = useMutation({
    mutationFn: ({ ids, organizationId }: { ids: string[]; organizationId: string | null }) => assignProjects(ids, organizationId),
    onSuccess: (count) => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
      setSelectedIds([]);
      setBulkOrgId("");
      setMoveTarget(null);
      toast({ title: t("Assigned"), description: t("{count} service(s) updated", { count }) });
    },
    onError: (err: Error) => toast({ title: t("Assign failed"), description: err.message, variant: "destructive" }),
  });

  const deploy = useMutation({
    mutationFn: ({ id, skip }: { id: string; skip: string[] }) => deployProject(id, skip),
    onSuccess: () => {
      refresh();
      toast({ title: t("Deploying") });
    },
    onError: (err: Error) => toast({ variant: "destructive", title: t("Could not start the deployment"), description: err.message }),
  });

  // every running service of the app, one after the other; stopped ones stay stopped
  const restart = useMutation({
    mutationFn: async (project: Project) => {
      for (const app of restartable(project)) await restartApplication(app.id);
    },
    onSuccess: (_, project) => {
      refresh();
      toast({ title: t("Restarted"), description: project.name });
    },
    onError: (err: Error) => toast({ variant: "destructive", title: t("Failed to restart service"), description: err.message }),
  });
  const restartable = (project: Project) => project.applications.filter((app) => !app.disabled && app.status === "RUNNING");

  if (error) {
    return (
      <div className="flex h-64 items-center justify-center text-center">
        <div>
          <AlertCircle className="mx-auto mb-4 h-12 w-12 text-destructive" />
          <p className="text-muted-foreground">{(error as Error).message}</p>
        </div>
      </div>
    );
  }

  const allSelected = projects.length > 0 && projects.every((project) => selectedIds.includes(project.id));
  const toggleOne = (id: string) => setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // the hostnames it answers on, paths left out (those are routing, on its page)
  const hostsOf = (project: Project) =>
    [...new Set(project.applications.flatMap((app) => app.domains.filter((d) => !d.path && isPublicHost(d.host)).map((d) => d.host)))].sort();

  const originOf = (project: Project) =>
    project.repository
      ? { icon: GitBranch, text: `${repoName(project.repository)} · ${project.branch || "main"}` }
      : project.kind !== "IMPORTED"
        ? { icon: Upload, text: t("Uploaded files") }
        : { icon: HardDrive, text: project.path && superAdmin ? project.path : t("Server folder (not git)") };

  const columns: Column<Project>[] = [
    ...(superAdmin
      ? [
          {
            header: (
              <Checkbox
                checked={allSelected}
                onCheckedChange={() => setSelectedIds(allSelected ? [] : projects.map((project) => project.id))}
                aria-label={t("Select all apps on this page")}
              />
            ),
            className: "w-10",
            cell: (project: Project) => (
              <div onClick={(e) => e.stopPropagation()}>
                <Checkbox checked={selectedIds.includes(project.id)} onCheckedChange={() => toggleOne(project.id)} aria-label={t("Select {name}", { name: project.name })} />
              </div>
            ),
          },
        ]
      : []),
    {
      header: t("App"),
      sortKey: "name",
      className: "w-[32%]",
      cell: (project) => {
        // what it is at a glance: one mark per kind of service in it
        const types = [...new Set(project.applications.map((app) => app.type))];
        const origin = originOf(project);
        return (
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex shrink-0 -space-x-1">
              {types.slice(0, 2).map((type) => {
                const meta = TYPES[type] ?? { label: type, icon: Layers, className: "text-muted-foreground" };
                return (
                  <span key={type} title={meta.label} className="flex h-8 w-8 items-center justify-center rounded-md border bg-card">
                    <meta.icon className={`h-4 w-4 ${meta.className}`} />
                  </span>
                );
              })}
            </span>
            <div className="min-w-0">
              <span className="flex min-w-0 items-center gap-1">
                <span className="truncate font-medium">{project.name}</span>
                <ProblemBadge project={project} />
                {/* rename in place: shown on row hover (always on touch), and it must not open the row */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenameTarget(project);
                  }}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-primary focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                  aria-label={t("Rename app")}
                  title={t("Rename app")}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </span>
              <span className="flex min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground" title={superAdmin ? project.path ?? undefined : undefined}>
                <origin.icon className="h-3 w-3 shrink-0" />
                <span className="truncate">{origin.text}</span>
              </span>
            </div>
          </div>
        );
      },
    },
    {
      header: t("Domain"),
      className: "w-[26%]",
      cell: (project) => {
        const [first, ...rest] = hostsOf(project);
        if (!first) return <span className="text-muted-foreground">—</span>;
        return (
          <div className="flex min-w-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            <a href={`https://${first}`} target="_blank" rel="noreferrer" className="truncate hover:text-primary hover:underline">
              {first}
            </a>
            <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
            {rest.length > 0 && (
              <span className="shrink-0 text-xs text-muted-foreground" title={rest.join("\n")}>
                +{rest.length}
              </span>
            )}
          </div>
        );
      },
    },
    {
      header: t("Created"),
      sortKey: "createdAt",
      sortFirst: "desc",
      className: "w-28 whitespace-nowrap text-xs text-muted-foreground",
      cell: (project) => (
        <span title={new Date(project.createdAt).toLocaleString(locale)}>
          {new Date(project.createdAt).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" })}
        </span>
      ),
    },
    {
      header: t("Last deploy"),
      className: "w-[22%]",
      cell: (project) => {
        const last = project.lastDeployment;
        if (!last) return <span className="text-muted-foreground">—</span>;
        const failed = last.status === "FAILED";
        return (
          <div className="min-w-0 text-sm" title={new Date(last.createdAt).toLocaleString(locale)}>
            <span className={`block truncate ${failed ? "text-destructive" : ""}`}>{last.commitMessage || (failed ? t("Deploy failed") : t("Deployed"))}</span>
            <span className="block text-xs text-muted-foreground">{ago(last.createdAt)}</span>
          </div>
        );
      },
    },
    ...(superAdmin
      ? [
          {
            header: t("Workspace"),
            className: "w-[13%]",
            sortKey: "organization",
            cell: (project: Project) => (
              <div className="min-w-0">
                <span className={`block truncate text-sm ${project.organization ? "" : "text-muted-foreground"}`}>{project.organization?.name ?? t("Unassigned")}</span>
                {project.server && (
                  <Link to={`/servers/${project.server.id}`} onClick={(e) => e.stopPropagation()} className="block truncate text-xs text-muted-foreground hover:underline">
                    {project.server.name}
                  </Link>
                )}
              </div>
            ),
          },
        ]
      : []),
    {
      header: <span className="sr-only">{t("Actions")}</span>,
      className: "w-10",
      // the row opens the app: the menu must not
      cell: (project) => {
        const site = hostsOf(project)[0];
        return (
          <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label={t("Actions for {name}", { name: project.name })}>
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {site && (
                  <DropdownMenuItem asChild>
                    <a href={`https://${site}`} target="_blank" rel="noreferrer">
                      <ExternalLink className="mr-2 h-4 w-4" />
                      {t("Open site")}
                    </a>
                  </DropdownMenuItem>
                )}
                {/* the panel builds it: one deploy for every service. An imported one is pulled on its page. */}
                {project.kind === "MANAGED" && (
                  <DropdownMenuItem
                    disabled={project.status === "DEPLOYING"}
                    onClick={() => {
                      setSkipMigrations(new Set());
                      setDeployTarget(project);
                    }}
                  >
                    <Rocket className="mr-2 h-4 w-4" />
                    {t("Redeploy")}
                  </DropdownMenuItem>
                )}
                {restartable(project).length > 0 && (
                  <DropdownMenuItem onClick={() => setRestartTarget(project)}>
                    <RotateCw className="mr-2 h-4 w-4" />
                    {t("Restart")}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setRenameTarget(project)}>
                  <Pencil className="mr-2 h-4 w-4" />
                  {t("Rename app")}
                </DropdownMenuItem>
                {/* ponytail: platform admins only — a deployed app's files and process stay under the old workspace's user until a redeploy */}
                {superAdmin && (
                  <DropdownMenuItem
                    onClick={() => {
                      setMoveOrgId(project.organization?.id ?? null);
                      setMoveTarget(project);
                    }}
                  >
                    <ArrowRightLeft className="mr-2 h-4 w-4" />
                    {t("Move workspace")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  ];

  const migrating = deployTarget?.applications.filter((app) => app.preDeployCommand) ?? [];

  return (
    <PageLayout
      title={t("Apps")}
      description={t("Your websites and apps.")}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {superAdmin && (
            <Button variant="outline" onClick={() => syncApps.mutate(undefined, { onSuccess: refresh })} disabled={syncApps.isPending}>
              {syncApps.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              {syncApps.isPending ? t("Syncing…") : t("Sync Apps")}
            </Button>
          )}
          <Button asChild className="bg-gradient-primary shadow-glow transition-all duration-300 hover:shadow-elegant">
            <Link to="/apps/new">
              <Plus className="mr-2 h-4 w-4" />
              {t("Add app")}
            </Link>
          </Button>
        </div>
      }
    >
      <DataTable
        columns={columns}
        rows={projects}
        rowKey={(project) => project.id}
        query={query}
        pagination={data?.pagination}
        isLoading={isLoading}
        searchPlaceholder={t("Search app, repository or domain…")}
        empty={t("No apps yet — add your first one.")}
        onRowClick={(project) => navigate(projectPath(project))}
        toolbar={
          superAdmin && selectedIds.length > 0 ? (
            <div className="flex items-center gap-2">
              <span className="whitespace-nowrap text-sm font-medium">{t("{count} selected", { count: selectedIds.length })}</span>
              <OrganizationCombobox value={bulkOrgId || null} onChange={(id) => setBulkOrgId(id ?? "")} placeholder={t("Assign to workspace")} className="w-56" />
              <Button disabled={!bulkOrgId || assign.isPending} onClick={() => assign.mutate({ ids: selectedIds, organizationId: bulkOrgId || null })}>
                {assign.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t("Assign")}
              </Button>
              <Button variant="ghost" onClick={() => setSelectedIds([])}>
                {t("Clear")}
              </Button>
            </div>
          ) : (
            <>
              <OrganizationFilter query={query} unassigned />
              {superAdmin && (
                <Select
                  value={serverFilter || ALL}
                  onValueChange={(value) => {
                    setServerFilter(value === ALL ? "" : value);
                    query.setPage(1);
                  }}
                >
                  <SelectTrigger className="h-10 w-40">
                    <ServerIcon className="mr-1 h-3.5 w-3.5 text-muted-foreground" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>{t("All servers")}</SelectItem>
                    {servers.map((server) => (
                      <SelectItem key={server.id} value={server.id}>
                        {server.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </>
          )
        }
      />

      {/* Redeploy: always asked, with the migrations to run or leave out this once */}
      <AlertDialog open={!!deployTarget} onOpenChange={(open) => !open && setDeployTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Deploy {name}?", { name: deployTarget?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("The new release builds beside the running one and takes over once it answers.")}</AlertDialogDescription>
          </AlertDialogHeader>
          {migrating.length > 0 && <MigrationChoices apps={migrating} skip={skipMigrations} onChange={setSkipMigrations} />}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => deployTarget && deploy.mutate({ id: deployTarget.id, skip: [...skipMigrations] })}>{t("Deploy")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!restartTarget} onOpenChange={(open) => !open && setRestartTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Restart {name}?", { name: restartTarget?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("Its running services restart one after the other: {services}. The site may not answer for a few seconds.", {
                services: restartTarget ? restartable(restartTarget).map((app) => app.name).join(", ") : "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => restartTarget && restart.mutate(restartTarget)}>{t("Restart")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!moveTarget} onOpenChange={(open) => !open && setMoveTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Move workspace")}</DialogTitle>
            <DialogDescription>
              {t("Choose which workspace owns {name}. Every service of the app goes with it.", { name: moveTarget?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <OrganizationCombobox value={moveOrgId} onChange={setMoveOrgId} noneLabel={t("Unassigned")} />
            <div className="flex items-center justify-end space-x-3">
              <Button variant="outline" onClick={() => setMoveTarget(null)}>
                {t("Cancel")}
              </Button>
              <Button disabled={assign.isPending} onClick={() => moveTarget && assign.mutate({ ids: [moveTarget.id], organizationId: moveOrgId })}>
                {assign.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t("Save")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {renameTarget && (
        <RenameProjectDialog key={renameTarget.id} project={renameTarget} open onOpenChange={(open) => !open && setRenameTarget(null)} />
      )}
    </PageLayout>
  );
}
