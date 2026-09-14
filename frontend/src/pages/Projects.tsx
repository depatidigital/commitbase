import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ExternalLink, FolderGit2, Layers, List, Loader2, Plus, RefreshCw, Server as ServerIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { OrganizationFilter } from "@/components/OrganizationFilter";
import { OrganizationCombobox } from "@/components/OrganizationCombobox";
import { TYPES as APP_TYPES } from "@/components/AppTypeBadge";
import { useToast } from "@/hooks/use-toast";
import { useSyncServerApps } from "@/hooks/useApplications";
import { isSuperAdmin } from "@/lib/auth";
import { locale, t } from "@/lib/i18n";
import { repoName, runtimeLabel } from "@/lib/applications";
import { appStatus, getApplicationHealth, type Health, type Tone } from "@/lib/health";
import { getServers } from "@/lib/servers";
import { appParts, assignProjects, getProjects, projectPath, type AppPart, type Project, type ProjectApp } from "@/lib/projects";

/** Radix Select cannot hold an empty value, so "no filter" needs a stand-in. */
const ALL = "__all__";

/** Compact relative time — "3d ago". The exact stamp lives in the title. */
const ago = (value: string) => {
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 3600) return t("{n}m ago", { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return t("{n}h ago", { n: Math.floor(seconds / 3600) });
  return t("{n}d ago", { n: Math.floor(seconds / 86400) });
};

const TONE_DOT: Record<Tone, string> = {
  up: "bg-success",
  down: "bg-destructive ring-4 ring-destructive/15",
  warn: "bg-warning",
  deploying: "",
  muted: "bg-muted-foreground/40",
};

function Dot({ tone, text }: { tone: Tone; text: string }) {
  return (
    <span className="flex items-center justify-center" title={text}>
      {tone === "deploying" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-warning" />
      ) : (
        <span className={`h-2.5 w-2.5 rounded-full ${TONE_DOT[tone]}`} />
      )}
      <span className="sr-only">{text}</span>
    </span>
  );
}

/**
 * The app list, one row per project ("Proyek"): a repository checkout or an
 * upload, with the apps ("Aplikasi") served from it listed inside the row,
 * each with its own uptime. The row opens the project — its apps are opened
 * from there; here they are only listed, with a link to the live site.
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

  // one request for the uptime of every app on the page, on the checks' rhythm
  const appIds = projects.flatMap((project) => project.applications.map((app) => app.id));
  const { data: healthById = {} } = useQuery({
    queryKey: ["applications", "health", appIds],
    queryFn: () => getApplicationHealth(appIds),
    enabled: appIds.length > 0,
    refetchInterval: 60_000,
  });
  const statusOf = (app: ProjectApp) => appStatus(app.status, healthById[app.id] as Health | undefined, app.disabled);

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

  // One line of a project's row per app (per path of a split hostname): its
  // uptime dot, type, address and open-link; how it runs, for the operator.
  // Only the open-link does anything — the row itself is the project's.
  const appLine = (app: ProjectApp, part: AppPart) => {
    const type = APP_TYPES[part.type] ?? { label: part.type.toLowerCase(), icon: Layers, className: "text-muted-foreground" };
    const TypeIcon = type.icon;
    // a sync placeholder like arusflow.pm2.local: nothing a browser can open
    const internal = app.domain.endsWith(".local");
    const health = healthById[app.id] as Health | undefined;
    const { tone, text } = statusOf(app);
    // what serves this part on the box: the app's own process, or Caddy
    const runtime = part.owner
      ? `${runtimeLabel(app.runtime)}${app.runtime === "PM2" && app.processName ? ` · ${app.processName}` : ""}`
      : part.proxyPort
        ? runtimeLabel("CADDY_PROXY")
        : runtimeLabel("CADDY_STATIC");
    const target = !app.routing?.length ? null : part.proxyPort ? `:${part.proxyPort}` : part.root?.split("/").slice(-2).join("/") ?? null;
    return (
      <div key={part.key} className={`flex min-w-0 items-center gap-2 ${app.disabled ? "opacity-50" : ""}`}>
        {/* the uptime check reaches the hostname, not its /api/*: the dot is the hostname line's */}
        <span className="w-3 shrink-0">
          {part.main && (
            <Dot
              tone={tone}
              text={[text, health?.uptime24h != null && t("{uptime}% up in the last 24 hours", { uptime: health.uptime24h }), health?.state !== "up" && health?.lastError]
                .filter(Boolean)
                .join(" · ")}
            />
          )}
        </span>
        <span className="flex w-20 shrink-0 items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-xs font-medium">
          <TypeIcon className={`h-3.5 w-3.5 shrink-0 ${type.className}`} />
          <span className="truncate">{type.label}</span>
        </span>
        <span className="truncate text-sm">{part.label}</span>
        {!internal && part.main && (
          <a
            href={`https://${app.domain}`}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-muted-foreground hover:text-primary"
            aria-label={t("Open {url}", { url: app.domain })}
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {superAdmin && (
          <span className="flex min-w-0 shrink items-center gap-1.5 text-xs text-muted-foreground">
            <Badge variant="outline" className={`shrink-0 px-1.5 py-0 text-[10px] font-medium ${app.runtime ? "border-warning/50 text-warning" : ""}`}>
              {runtime}
            </Badge>
            {target && <span className="truncate font-mono">→ {target}</span>}
          </span>
        )}
        {part.main && health?.uptime24h != null && (
          <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground" title={t("Successful checks in the last 24 hours")}>
            {t("{uptime}% / 24h", { uptime: health.uptime24h })}
          </span>
        )}
      </div>
    );
  };

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
            className: "w-10 align-top",
            cell: (project: Project) => (
              <Checkbox
                checked={selectedIds.includes(project.id)}
                onCheckedChange={() => toggleOne(project.id)}
                aria-label={t("Select {name}", { name: project.name })}
              />
            ),
          },
        ]
      : []),
    {
      header: t("Project"),
      sortKey: "name",
      className: "align-top",
      // the project, and its apps under its name — one row, one way in
      cell: (project) => {
        const down = project.applications.filter((app) => statusOf(app).tone === "down").length;
        return (
          <div className="min-w-0 space-y-1.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate font-medium">{project.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {t("{count} apps", { count: project.applications.reduce((sum, app) => sum + appParts(app).length, 0) })}
              </span>
              {down > 0 && <span className="shrink-0 text-xs font-medium text-destructive">· {t("{count} down", { count: down })}</span>}
            </span>
            <div className="space-y-1 pl-1">
              {project.applications.flatMap((app) => appParts(app).map((part) => appLine(app, part)))}
            </div>
          </div>
        );
      },
    },
    {
      header: t("Repository"),
      className: "w-[18%] align-top",
      // where the code comes from; for a monorepo, the folders of its apps
      cell: (project) => (
        <div className="min-w-0 space-y-0.5 font-mono text-xs text-muted-foreground">
          <span className="block truncate" title={project.repository ?? undefined}>
            {project.repository ? `${repoName(project.repository)} · ${project.branch || "main"}` : t("Uploaded files")}
          </span>
          {[...new Set(project.applications.map((app) => app.rootDirectory).filter(Boolean))].map((dir) => (
            <span key={dir} className="block truncate">
              {dir}
            </span>
          ))}
        </div>
      ),
    },
    ...(superAdmin
      ? [
          {
            // where it lives on the server: the checkout a pull updates
            header: t("Folder"),
            className: "w-[18%] align-top",
            cell: (project: Project) => (
              <span className="block truncate font-mono text-xs text-muted-foreground" title={project.path ?? undefined}>
                {project.path ?? "—"}
              </span>
            ),
          },
          {
            header: t("Organization"),
            className: "w-[12%] align-top",
            sortKey: "organization",
            cell: (project: Project) => (
              <button
                type="button"
                title={t("Change organization")}
                className="max-w-full"
                onClick={() => {
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
            className: "w-28 align-top text-xs",
            sortKey: "server",
            cell: (project: Project) =>
              project.server ? (
                <Link to={`/servers/${project.server.id}`} className="truncate hover:underline">
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
      className: "w-28 align-top text-xs",
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
