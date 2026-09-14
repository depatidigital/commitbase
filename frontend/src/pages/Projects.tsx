import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ExternalLink, GitBranch, HardDrive, Upload, Layers, List, Loader2, Plus, RefreshCw, Server as ServerIcon } from "lucide-react";
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
import { hostsOf, repoName, runtimeLabel } from "@/lib/applications";
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

  // An app's lines — one per path of a split hostname — in the Apps column and
  // again, lined up (same height), in the Uptime column.
  const LINE = "flex h-6 min-w-0 items-center gap-1.5";
  // A site under several names gets a line per name, all alike; the uptime and
  // what serves it are said once, on the first — they are one check, one app.
  const partsOf = (project: Project) =>
    project.applications.flatMap((app) => {
      const [main, ...paths] = appParts(app) as Array<AppPart & { repeat?: boolean }>;
      const hosts = app.aliases?.length
        ? hostsOf(app).map((host, i) => ({ ...main!, key: `${app.id}:${host}`, label: host, repeat: i > 0 }))
        : [main!];
      return [...hosts, ...paths].map((part) => ({ app, part }));
    });

  // where the code comes from, said under the project's name
  const originOf = (project: Project) =>
    project.repository
      ? `${repoName(project.repository)} · ${project.branch || "main"}`
      : project.kind !== "IMPORTED"
        ? t("Uploaded files")
        : project.path
          ? // the folder itself says it better, to whoever may see it
            superAdmin ? project.path : t("Server folder (not git)")
          : t("On the server (folder not detected)");

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
      className: "w-[24%] align-top",
      cell: (project) => {
        const down = project.applications.filter((app) => statusOf(app).tone === "down").length;
        return (
          <div className="min-w-0">
            <span className="flex h-6 min-w-0 items-center gap-1.5">
              <span className="truncate font-medium">{project.name}</span>
              {down > 0 && <span className="shrink-0 text-xs font-medium text-destructive">{t("{count} down", { count: down })}</span>}
            </span>
            <span
              className="flex min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground"
              // the checkout a pull updates, for whoever may see it
              title={[project.repository, superAdmin && project.path].filter(Boolean).join("\n") || undefined}
            >
              {/* where it comes from, as a mark: a branch, an upload, or a folder on the server */}
              {project.repository ? (
                <GitBranch className="h-3 w-3 shrink-0" />
              ) : project.kind === "IMPORTED" ? (
                <HardDrive className="h-3 w-3 shrink-0" />
              ) : (
                <Upload className="h-3 w-3 shrink-0" />
              )}
              <span className="truncate">{originOf(project)}</span>
            </span>
            {/* a monorepo the panel builds: the folders its apps are built from */}
            {project.kind === "MANAGED" && [...new Set(project.applications.map((app) => app.rootDirectory).filter(Boolean))].map((dir) => (
              <span key={dir} className="block truncate font-mono text-xs text-muted-foreground">
                {dir}
              </span>
            ))}
          </div>
        );
      },
    },
    {
      header: t("Apps"),
      className: "align-top",
      // listed, not links: the row is the project's; only the site opens from here
      cell: (project) => (
        <div className="min-w-0">
          {partsOf(project).map(({ app, part }) => {
            const type = APP_TYPES[part.type] ?? { label: part.type.toLowerCase(), icon: Layers, className: "text-muted-foreground" };
            const TypeIcon = type.icon;
            const internal = app.domain.endsWith(".local");
            // what serves this part on the box: the app's own process, or Caddy
            const runtime = part.owner
              ? `${runtimeLabel(app.runtime)}${app.runtime === "PM2" && app.processName ? ` · ${app.processName}` : ""}`
              : runtimeLabel(part.proxyPort ? "CADDY_PROXY" : "CADDY_STATIC");
            const target = !app.routing?.length ? null : part.proxyPort ? `:${part.proxyPort}` : part.root?.split("/").slice(-2).join("/") ?? null;
            return (
              <div key={part.key} className={`${LINE} ${app.disabled ? "opacity-50" : ""}`}>
                {part.main ? (
                  <>
                    <span title={type.label} className="shrink-0">
                      <TypeIcon className={`h-3.5 w-3.5 ${type.className}`} />
                    </span>
                    <span className="truncate text-sm">{part.label}</span>
                    {!internal && (
                      <a
                        href={`https://${part.label}`}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 text-muted-foreground hover:text-primary"
                        aria-label={t("Open {url}", { url: part.label })}
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </>
                ) : (
                  // a path of the hostname above it
                  <>
                    <span className="shrink-0 pl-1 text-muted-foreground">└</span>
                    <span title={type.label} className="shrink-0">
                      <TypeIcon className={`h-3.5 w-3.5 ${type.className}`} />
                    </span>
                    <span className="truncate font-mono text-xs">{part.label.slice(app.domain.length) || part.label}</span>
                  </>
                )}
                {superAdmin && !part.repeat && (
                  <span className="flex min-w-0 shrink items-center gap-1.5 text-xs text-muted-foreground">
                    <Badge variant="outline" className={`shrink-0 px-1.5 py-0 text-[10px] font-medium ${app.runtime ? "border-warning/50 text-warning" : ""}`}>
                      {runtime}
                    </Badge>
                    {target && <span className="truncate font-mono">→ {target}</span>}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ),
    },
    {
      header: t("Uptime 24h"),
      className: "w-36 whitespace-nowrap align-top text-right text-xs",
      // lined up with the apps' lines; a path has no check of its own
      cell: (project) => (
        <div>
          {partsOf(project).map(({ app, part }) => {
            const health = healthById[app.id] as Health | undefined;
            const { tone, text } = statusOf(app);
            const down = tone === "down";
            return (
              <div key={part.key} className="flex h-6 items-center justify-end gap-1.5">
                {/* the state and the number behind it, together; a path has no check of its own */}
                {part.main && !part.repeat && (
                  <>
                    <Dot tone={tone} text={[text, health?.state !== "up" && health?.lastError].filter(Boolean).join(" · ")} />
                    {health?.uptime24h != null && (
                      <span className={down ? "font-medium text-destructive" : "text-muted-foreground"}>{health.uptime24h}%</span>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      ),
    },
    ...(superAdmin
      ? [
          {
            // who owns it, and the box it runs on under that
            header: t("Organization"),
            className: "w-[13%] align-top",
            sortKey: "organization",
            cell: (project: Project) => (
              <div className="min-w-0">
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
                {project.server && (
                  <Link to={`/servers/${project.server.id}`} className="block truncate text-xs text-muted-foreground hover:underline">
                    {project.server.name}
                  </Link>
                )}
              </div>
            ),
          },
        ]
      : []),
    {
      header: t("Last deploy"),
      className: "w-36 whitespace-nowrap align-top text-xs",
      cell: (project) => {
        const last = project.lastDeployment;
        return (
          <span className="flex h-6 items-center">
            {last ? (
              <span
                className={last.status === "FAILED" ? "text-destructive" : ""}
                title={`${new Date(last.createdAt).toLocaleString(locale)}${last.commitMessage ? ` · ${last.commitMessage}` : ""}`}
              >
                {ago(last.createdAt)}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
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
