import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, FolderGit2, List, Loader2, Plus, RefreshCw, Server as ServerIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { OrganizationFilter } from "@/components/OrganizationFilter";
import { OrganizationCombobox } from "@/components/OrganizationCombobox";
import { useToast } from "@/hooks/use-toast";
import { useSyncServerApps } from "@/hooks/useApplications";
import { isSuperAdmin } from "@/lib/auth";
import { locale, t } from "@/lib/i18n";
import { repoName } from "@/lib/applications";
import { getServers } from "@/lib/servers";
import { assignProjects, getProjects, PROJECT_STATUS, projectPath, type Project } from "@/lib/projects";

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
 * The app list, one row per project ("Proyek"): a repository checkout or an
 * upload, and the apps ("Aplikasi") served from it. Most have one app, and
 * open straight onto it; a monorepo or a multi-site checkout opens its project.
 */
export default function Projects() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const superAdmin = isSuperAdmin();
  const query = useTableQuery(100);
  const syncApps = useSyncServerApps();
  const [serverFilter, setServerFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkOrgId, setBulkOrgId] = useState("");
  const [assignTarget, setAssignTarget] = useState<{ id: string; name: string } | null>(null);
  const [assignOrgId, setAssignOrgId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["projects", query.params, serverFilter],
    queryFn: () => getProjects({ ...query.params, serverId: serverFilter }),
    // statuses move during deploys and syncs
    refetchInterval: 15_000,
  });
  const projects = data?.data ?? [];

  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: getServers, enabled: superAdmin });

  const assign = useMutation({
    mutationFn: ({ ids, organizationId }: { ids: string[]; organizationId: string | null }) => assignProjects(ids, organizationId),
    onSuccess: (count) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["applications"] });
      setSelectedIds([]);
      setBulkOrgId("");
      setAssignTarget(null);
      toast({ title: t("Assigned"), description: t("{count} application(s) updated", { count }) });
    },
    onError: (err: Error) => toast({ title: t("Assign failed"), description: err.message, variant: "destructive" }),
  });

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

  const columns: Column<Project>[] = [
    ...(superAdmin
      ? [
          {
            header: (
              <Checkbox
                checked={allSelected}
                onCheckedChange={() => setSelectedIds(allSelected ? [] : projects.map((project) => project.id))}
                aria-label={t("Select all projects on this page")}
              />
            ),
            className: "w-10",
            cell: (project: Project) => (
              <Checkbox
                checked={selectedIds.includes(project.id)}
                onCheckedChange={() => toggleOne(project.id)}
                onClick={(event) => event.stopPropagation()}
                aria-label={t("Select {name}", { name: project.name })}
              />
            ),
          },
        ]
      : []),
    {
      header: "",
      className: "w-10",
      cell: (project) => {
        const status = PROJECT_STATUS[project.status] ?? PROJECT_STATUS.STOPPED;
        return (
          <span className="flex items-center justify-center" title={status.text}>
            {project.status === "DEPLOYING" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-warning" />
            ) : (
              <span className={`h-2.5 w-2.5 rounded-full ${status.dot}`} />
            )}
            <span className="sr-only">{status.text}</span>
          </span>
        );
      },
    },
    {
      header: t("Project"),
      sortKey: "name",
      cell: (project) => (
        <div className="min-w-0">
          <span className="flex min-w-0 items-center gap-1.5">
            <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <Link
              to={projectPath(project)}
              onClick={(event) => event.stopPropagation()}
              className="truncate font-medium transition-colors hover:text-primary"
            >
              {project.name}
            </Link>
          </span>
          {/* where the code comes from: the repository and branch, else the folder */}
          <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground" title={project.path ?? project.repository ?? undefined}>
            {project.repository
              ? `${repoName(project.repository)} · ${project.branch || "main"}`
              : project.path ?? t("Uploaded files")}
          </span>
        </div>
      ),
    },
    {
      header: t("Apps"),
      className: "w-[30%]",
      sortKey: "apps",
      // its hostnames, as many as fit; the count says the rest
      cell: (project) => (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {project.applications.slice(0, 3).map((app) => (
            <Link
              key={app.id}
              to={`/application/${app.id}`}
              onClick={(event) => event.stopPropagation()}
              className={`max-w-full truncate rounded-md bg-muted px-1.5 py-0.5 text-xs hover:text-primary ${app.disabled ? "opacity-50" : ""}`}
              title={app.domain}
            >
              {app.domain.endsWith(".local") ? app.name : app.domain}
            </Link>
          ))}
          {project.applications.length > 3 && (
            <span className="text-xs text-muted-foreground">{t("+{count} more", { count: project.applications.length - 3 })}</span>
          )}
        </div>
      ),
    },
    ...(superAdmin
      ? [
          {
            header: t("Organization"),
            className: "w-[14%]",
            sortKey: "organization",
            cell: (project: Project) => (
              <button
                type="button"
                title={t("Change organization")}
                className="max-w-full"
                onClick={(event) => {
                  event.stopPropagation();
                  setAssignOrgId(project.organization?.id ?? null);
                  setAssignTarget({ id: project.id, name: project.name });
                }}
              >
                {project.organization ? (
                  <Badge variant="outline" className="max-w-full truncate hover:border-primary">
                    {project.organization.name}
                  </Badge>
                ) : (
                  <span className="text-xs text-primary underline-offset-2 hover:underline">{t("Unassigned — assign")}</span>
                )}
              </button>
            ),
          },
          {
            header: t("Server"),
            className: "w-28 text-xs",
            sortKey: "server",
            cell: (project: Project) =>
              project.server ? (
                <Link to={`/servers/${project.server.id}`} onClick={(event) => event.stopPropagation()} className="truncate hover:underline">
                  {project.server.name}
                </Link>
              ) : (
                <span className="text-muted-foreground">—</span>
              ),
          },
        ]
      : []),
    {
      header: t("Last deploy"),
      className: "w-32 text-xs",
      cell: (project) => {
        const last = project.lastDeployment;
        if (!last) return <span className="text-muted-foreground">—</span>;
        return (
          <span title={`${new Date(last.createdAt).toLocaleString(locale)}${last.commitMessage ? ` · ${last.commitMessage}` : ""}`}>
            <span className={last.status === "FAILED" ? "text-destructive" : ""}>{ago(last.createdAt)}</span>
          </span>
        );
      },
    },
  ];

  return (
    <PageLayout
      title={t("Projects")}
      description={t("Your code and the apps served from it.")}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {/* the flat list, one row per hostname, with its uptime checks */}
          <Button variant="ghost" asChild>
            <Link to="/applications">
              <List className="mr-2 h-4 w-4" />
              {t("All apps")}
            </Link>
          </Button>
          {superAdmin && (
            <Button
              variant="outline"
              onClick={() =>
                syncApps.mutate(undefined, { onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["projects"] }) })
              }
              disabled={syncApps.isPending}
            >
              {syncApps.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              {syncApps.isPending ? t("Syncing…") : t("Sync Apps")}
            </Button>
          )}
          <Button asChild className="bg-gradient-primary shadow-glow transition-all duration-300 hover:shadow-elegant">
            <Link to="/add-app">
              <Plus className="mr-2 h-4 w-4" />
              {t("Add project")}
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
        searchPlaceholder={t("Search project, repository or domain…")}
        empty={t("No projects yet — add your first one.")}
        onRowClick={(project) => navigate(projectPath(project))}
        toolbar={
          superAdmin && selectedIds.length > 0 ? (
            <div className="flex items-center gap-2">
              <span className="whitespace-nowrap text-sm font-medium">{t("{count} selected", { count: selectedIds.length })}</span>
              <OrganizationCombobox
                value={bulkOrgId || null}
                onChange={(id) => setBulkOrgId(id ?? "")}
                placeholder={t("Assign to organization")}
                className="w-56"
              />
              <Button
                disabled={!bulkOrgId || assign.isPending}
                onClick={() => assign.mutate({ ids: selectedIds, organizationId: bulkOrgId || null })}
              >
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

      <Dialog open={!!assignTarget} onOpenChange={(open) => !open && setAssignTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Assign organization")}</DialogTitle>
            <DialogDescription>
              {t("Choose which organization owns {name}. Every app of the project goes with it.", { name: assignTarget?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <OrganizationCombobox value={assignOrgId} onChange={setAssignOrgId} noneLabel={t("Unassigned")} />
            <div className="flex items-center justify-end space-x-3">
              <Button variant="outline" onClick={() => setAssignTarget(null)}>
                {t("Cancel")}
              </Button>
              <Button
                disabled={assign.isPending}
                onClick={() => assignTarget && assign.mutate({ ids: [assignTarget.id], organizationId: assignOrgId })}
              >
                {assign.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t("Save")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </PageLayout>
  );
}
