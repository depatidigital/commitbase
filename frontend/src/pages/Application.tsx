import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { DomainExpiryBadge } from "@/components/DomainExpiryBadge";
import { PageLayout } from "@/components/PageLayout";
import { OrganizationFilter } from "@/components/OrganizationFilter";
import {
  Server,
  Plus,
  AlertCircle,
  Zap,
  Globe,
  HardDrive,
  Cpu,
  Play,
  Square,
  Upload,
  RotateCcw,
  Trash2,
  Search,
  Loader2,
  RefreshCw,
  Eye,
  ExternalLink,
  MoreHorizontal,
  Layers,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HeartbeatBar } from "@/components/HeartbeatBar";
import { TYPES as APP_TYPES } from "@/components/AppTypeBadge";
import { getServers } from "@/lib/servers";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Radix Select cannot hold an empty value, so "no filter" needs a stand-in. */
const ALL = "__all__";
import { getApplicationHealth, type Health } from "@/lib/health";
import { useToast } from "@/hooks/use-toast";
import { locale, t } from "@/lib/i18n";
import {
  useApplicationsWithRealtime,
  useStartApplication,
  useStartExistingApplication,
  useStopApplication,
  useRestartApplication,
  useDeleteApplication,
  useSyncServerApps,
} from "@/hooks/useApplications";
import { isSuperAdmin } from "@/lib/auth";
import { useDomains } from "@/hooks/useDomains";
import { bulkAssignApplications, hasBeenDeployed } from "@/lib/applications";
import { OrganizationCombobox } from "@/components/OrganizationCombobox";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

/** How an imported app is run on its box, for the "Manual" badge. */
const RUNTIME_LABEL: Record<string, string> = {
  PM2: "pm2",
  CADDY_PHP: "Caddy + PHP-FPM",
  CADDY_STATIC: "Caddy (static files)",
  CADDY_PROXY: "Caddy (reverse proxy)",
};

/** Compact relative time — "3d ago". The exact stamp lives in the title. */
const ago = (value: string) => {
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 3600) return t("{n}m ago", { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return t("{n}h ago", { n: Math.floor(seconds / 3600) });
  return t("{n}d ago", { n: Math.floor(seconds / 86400) });
};

type Tone = "up" | "down" | "warn" | "deploying" | "muted";
const TONE_DOT: Record<Tone, string> = {
  up: "bg-success",
  down: "bg-destructive",
  warn: "bg-warning",
  deploying: "",
  muted: "bg-muted-foreground/40",
};

/**
 * One word for "is it OK?", from the app's own status and the uptime checks.
 * `rank` puts what needs a look first: broken, then in flight, then fine.
 */
const appStatus = (status: string, health?: Health): { text: string; tone: Tone; rank: number } => {
  if (status === "DEPLOYING" || status === "BUILDING") return { text: t("Deploying"), tone: "deploying", rank: 1 };
  // stopped on purpose — not an outage, whatever the checks say
  if (status === "STOPPED") return { text: t("Stopped"), tone: "muted", rank: 3 };
  if (health?.state === "down") return { text: t("Down"), tone: "down", rank: 0 };
  // failing lately, not yet long enough to call it an outage
  if (health?.state === "pending") return { text: t("Unstable"), tone: "warn", rank: 0 };
  if (health?.state === "up") return { text: t("Online"), tone: "up", rank: 2 };
  if (status === "ERROR") return { text: t("Error"), tone: "down", rank: 0 };
  return { text: t("Not monitored"), tone: "muted", rank: 4 };
};

/**
 * When the current run of failed checks began — beats are stored newest first.
 * Unknown when every kept beat failed: the oldest one is only where the kept
 * history ends, not where the outage started.
 */
const downSince = (health?: Health) => {
  const beats = health?.beats ?? [];
  const lastOk = beats.findIndex((beat) => beat.ok);
  return lastOk > 0 ? beats[lastOk - 1].at : undefined;
};

export default function Application() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // every app on one page for almost everyone; unsorted, the server puts what
  // needs attention first (broken, deploying), then by name
  const query = useTableQuery(100);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkOrgId, setBulkOrgId] = useState("");
  const [confirmAction, setConfirmAction] = useState<{
    type: "stop" | "delete";
    appId: string;
    appName: string;
  } | null>(null);
  const { toast } = useToast();
  const syncApps = useSyncServerApps();
  const superAdmin = isSuperAdmin();

  // page-specific filters on top of the shared table query; a change goes back
  // to page 1 like the organization filter does
  const [typeFilter, setTypeFilter] = useState("");
  const [serverFilter, setServerFilter] = useState("");
  const [domainFilter, setDomainFilter] = useState("");
  // only domains that have an app — the rest would filter to an empty table
  const { data: allDomains = [] } = useDomains();
  const domainsWithApps = allDomains
    .filter((domain) => (domain._count?.applications ?? 0) > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  const { data: servers = [] } = useQuery({
    queryKey: ["servers"],
    queryFn: getServers,
    // the node list is superadmin-only on the API
    enabled: superAdmin,
  });

  // API hooks
  const {
    data: applicationsData,
    isLoading,
    error,
  } = useApplicationsWithRealtime({ ...query.params, type: typeFilter, serverId: serverFilter, domainId: domainFilter });
  const startApp = useStartApplication();
  const startExistingApp = useStartExistingApplication();
  const stopApp = useStopApplication();
  const restartApp = useRestartApplication();
  const deleteApp = useDeleteApplication();

  const applications = applicationsData?.data || [];

  // One request for the whole page's history — a call per row would be 25 round
  // trips for one screen. Refetched on the same rhythm the checks are written.
  const ids = applications.map((app) => app.id);
  const { data: healthById = {} } = useQuery({
    queryKey: ["applications", "health", ids],
    queryFn: () => getApplicationHealth(ids),
    enabled: ids.length > 0,
    refetchInterval: 60_000,
  });

  // one app from its row's modal, or the selection from the bulk bar
  const [assignTarget, setAssignTarget] = useState<{ id: string; name: string } | null>(null);
  const [assignOrgId, setAssignOrgId] = useState<string | null>(null);

  const bulkAssign = useMutation({
    mutationFn: ({ ids, organizationId }: { ids: string[]; organizationId: string | null }) =>
      bulkAssignApplications(ids, organizationId),
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ["applications"] });
      setSelectedIds([]);
      setBulkOrgId("");
      setAssignTarget(null);
      toast({ title: t("Assigned"), description: t("{count} application(s) updated", { count }) });
    },
    onError: (error: Error) =>
      toast({ title: t("Assign failed"), description: error.message, variant: "destructive" }),
  });

  const allSelected =
    applications.length > 0 && applications.every((app) => selectedIds.includes(app.id));

  const toggleAll = () =>
    setSelectedIds(allSelected ? [] : applications.map((app) => app.id));

  const toggleOne = (id: string) =>
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  // no confirm: a deploy replaces nothing until it works, and a start or
  // restart only brings back what was running. Stop and Delete still ask.
  const handleStart = (id: string) => startApp.mutate(id);
  const handleStartExisting = (id: string) => startExistingApp.mutate(id);
  const handleRestart = (id: string) => restartApp.mutate(id);

  const handleStop = async (id: string, name: string) => {
    setConfirmAction({ type: "stop", appId: id, appName: name });
  };

  const handleDelete = async (id: string, name: string) => {
    setConfirmAction({ type: "delete", appId: id, appName: name });
  };

  const executeAction = async () => {
    if (!confirmAction) return;

    try {
      switch (confirmAction.type) {
        case "stop":
          await stopApp.mutateAsync(confirmAction.appId);
          break;
        case "delete":
          await deleteApp.mutateAsync(confirmAction.appId);
          break;
      }
    } catch (error) {
      // Error is handled by the mutation
    } finally {
      setConfirmAction(null);
    }
  };

  const getDialogContent = () => {
    if (!confirmAction) return null;

    const { type, appName } = confirmAction;

    switch (type) {
      case "stop":
        return {
          title: t("Stop App"),
          description: t("Are you sure you want to stop \"{name}\"? This will shut down the running application.", { name: appName }),
          actionText: t("Stop App"),
          variant: "destructive" as const,
        };
      case "delete":
        return {
          title: t("Delete App"),
          description: t("Are you sure you want to delete \"{name}\"? This action cannot be undone and will permanently remove the application and all its data.", { name: appName }),
          actionText: t("Delete App"),
          variant: "destructive" as const,
        };
    }
  };

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-2">
            {t("Error Loading Apps")}
          </h3>
          <p className="text-muted-foreground">
            {t("Failed to load applications. Please try again.")}
          </p>
        </div>
      </div>
    );
  }

  const dialogContent = getDialogContent();

  // What needs a look comes first. The server orders by the app's own status;
  // the uptime checks are only known here, so they refine it on the page.
  // ponytail: sorts within the loaded page — fine at 100 per page
  const rows = query.sort
    ? applications
    : [...applications].sort(
        (a, b) => appStatus(a.status, healthById[a.id]).rank - appStatus(b.status, healthById[b.id]).rank,
      );

  const columns: Column<(typeof applications)[number]>[] = [
    ...(superAdmin
      ? [
          {
            header: (
              <Checkbox
                checked={allSelected}
                onCheckedChange={toggleAll}
                aria-label={t("Select all applications on this page")}
              />
            ),
            className: "w-10",
            cell: (app: (typeof applications)[number]) => (
              <Checkbox
                checked={selectedIds.includes(app.id)}
                onCheckedChange={() => toggleOne(app.id)}
                aria-label={t("Select {name}", { name: app.name })}
              />
            ),
          },
        ]
      : []),
    {
      // no header text: a column of dots explains itself, and problems sort first anyway
      header: "",
      className: "w-10",
      cell: (app) => {
        const health = healthById[app.id];
        const { text, tone } = appStatus(app.status, health);
        const since = tone === "down" ? downSince(health) : undefined;
        // the word and the numbers behind the colour, for whoever hovers
        const detail = [
          since ? `${text} · ${ago(since)}` : text,
          health?.uptime24h != null && t("{uptime}% up in the last 24 hours", { uptime: health.uptime24h }),
          health?.responseMs != null && `${health.responseMs}ms`,
          health?.state !== "up" && health?.lastError,
        ].filter(Boolean).join(" · ");
        return (
          <span className="flex items-center justify-center" title={detail}>
            {tone === "deploying" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-warning" />
            ) : (
              <span className={`h-2.5 w-2.5 rounded-full ${TONE_DOT[tone]} ${tone === "down" ? "ring-4 ring-destructive/15" : ""}`} />
            )}
            <span className="sr-only">{text}</span>
          </span>
        );
      },
    },
    {
      header: t("Application"),
      // no width: the name takes whatever the other columns leave
      sortKey: "name",
      // name and hostname are the same string for every imported site, so they
      // share one cell: the name leads, the address and the owner sit under it
      cell: (app) => {
        // an imported site is named after its hostname, so printing both is
        // printing the same string twice — the second line only earns its
        // place when the app was given a name of its own
        // a sync placeholder like arusflow.pm2.local: nothing a browser can open,
        // and nothing a client should have to read
        const internal = app.domain.endsWith(".local");
        const named = !internal && app.name.trim().toLowerCase() !== app.domain.trim().toLowerCase();
        // what kind of app, as its icon — a column of badges said the same thing louder
        const type = APP_TYPES[app.type] ?? { label: app.type.toLowerCase(), icon: Layers, className: "text-muted-foreground" };
        const TypeIcon = type.icon;
        // the operator only: manual = synced from the box, and the loopback port
        const manual = superAdmin && !!app.runtime;

        return (
          <div className="flex min-w-0 items-center gap-3">
          {/* icon and name: an icon alone had to be learned. Fixed width, so the app names line up */}
          <span
            className="flex w-20 shrink-0 items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs font-medium"
            title={superAdmin && app.port ? `${type.label} · 127.0.0.1:${app.port}` : undefined}
          >
            <TypeIcon className={`h-3.5 w-3.5 shrink-0 ${type.className}`} />
            <span className="truncate">{type.label}</span>
          </span>
          <div className="min-w-0">
            <span className="flex min-w-0 items-center gap-1.5">
              <Link
                to={`/application/${app.id}`}
                className="truncate font-medium transition-colors hover:text-primary"
              >
                {app.name}
              </Link>
              <DomainExpiryBadge domain={app.parentDomain} />
              {!internal && (
                <a
                  href={`https://${app.domain}`}
                  target="_blank"
                  rel="noreferrer"
                  title={t("Open {url}", { url: `https://${app.domain}` })}
                  aria-label={t("Open {url}", { url: app.domain })}
                  className="shrink-0 text-muted-foreground hover:text-primary"
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </span>
            {(named || manual) && (
              <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                {/* imported by the server sync: set up by hand, run under its own
                    user — the panel watches it but never deploys or provisions it.
                    On the second line so it never costs the name its width. */}
                {manual && (
                  <Badge
                    variant="outline"
                    className="shrink-0 border-warning/40 px-1.5 py-0 text-[10px] font-medium text-warning"
                    title={t("Set up by hand on {runtime} — the panel monitors it but does not deploy it or provision for it.", {
                      runtime: RUNTIME_LABEL[app.runtime!] ?? app.runtime,
                    })}
                  >
                    {t("Manual")}
                  </Badge>
                )}
                {named && <span className="truncate">{app.domain}</span>}
              </span>
            )}
          </div>
          </div>
        );
      },
    },
    ...(superAdmin
      ? [
          {
            header: t("Organization"),
            className: "w-[16%]",
            sortKey: "organization",
            // its own column only because a superadmin is the one who assigns
            // it — everyone else sees a single organization's apps anyway
            cell: (app: (typeof applications)[number]) => (
              <button
                type="button"
                title={t("Change organization")}
                className="max-w-full"
                onClick={() => {
                  setAssignOrgId(app.organization?.id ?? null);
                  setAssignTarget({ id: app.id, name: app.name });
                }}
              >
                {app.organization ? (
                  <Badge variant="outline" className="max-w-full truncate hover:border-primary">
                    {app.organization.name}
                  </Badge>
                ) : (
                  <span className="text-xs text-primary underline-offset-2 hover:underline">
                    {t("Unassigned — assign")}
                  </span>
                )}
              </button>
            ),
          },
        ]
      : []),
    // what it runs on and how it has been doing: for the operator. A client has
    // the status word, and no access to the servers anyway.
    ...(superAdmin
      ? [
          {
            header: t("Server"),
            className: "w-28 text-xs",
            sortKey: "server",
            cell: (app: (typeof applications)[number]) =>
              app.server ? (
                <Link to={`/servers/${app.server.id}`} className="truncate hover:underline">
                  {app.server.name}
                </Link>
              ) : (
                <span className="text-muted-foreground">—</span>
              ),
          },
          {
            header: t("Last 30 checks"),
            className: "w-[18%]",
            cell: (app: (typeof applications)[number]) => {
              const health = healthById[app.id];
              return (
                <div className="space-y-0.5">
                  <HeartbeatBar health={health} />
                  {health?.uptime24h != null && (
                    <span className="block text-xs text-muted-foreground" title={t("Successful checks in the last 24 hours")}>
                      {t("{uptime}% / 24h", { uptime: health.uptime24h })}
                    </span>
                  )}
                </div>
              );
            },
          },
          {
            header: t("Created"),
            className: "w-28 text-xs",
            sortKey: "createdAt",
            cell: (app: (typeof applications)[number]) => (
              <span title={new Date(app.createdAt).toLocaleString(locale)}>
                {new Date(app.createdAt).toLocaleDateString(locale, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </span>
            ),
          },
        ]
      : []),
    {
      header: t("Last deploy"),
      className: "w-32 text-xs",
      cell: (app) => {
        const at = app.deployments?.[0]?.createdAt;
        if (!at) return <span className="text-muted-foreground">—</span>;
        return <span title={new Date(at).toLocaleString(locale)}>{ago(at)}</span>;
      },
    },
    {
      header: "",
      className: "w-16 text-right",
      cell: (app) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              aria-label={t("Actions for {name}", { name: app.name })}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onClick={() => navigate(`/application/${app.id}`)}>
              <Eye className="mr-2 h-4 w-4" />
              {t("Manage")}
            </DropdownMenuItem>

            {app.status === "RUNNING" ? (
              <DropdownMenuItem
                disabled={stopApp.isPending}
                onClick={() => handleStop(app.id, app.name)}
              >
                <Square className="mr-2 h-4 w-4" />
                {t("Stop")}
              </DropdownMenuItem>
            ) : hasBeenDeployed(app) ? (
              <DropdownMenuItem
                disabled={startExistingApp.isPending}
                onClick={() => handleStartExisting(app.id)}
              >
                <Play className="mr-2 h-4 w-4" />
                {t("Start")}
              </DropdownMenuItem>
            ) : null}

            {app.status === "RUNNING" && (
              <DropdownMenuItem
                disabled={restartApp.isPending}
                onClick={() => handleRestart(app.id)}
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                {t("Restart")}
              </DropdownMenuItem>
            )}

            {/* an imported site is supervised by whoever set it up, not by us —
                offering a redeploy would promise something we cannot do */}
            {!app.runtime && (
              <DropdownMenuItem
                disabled={startApp.isPending}
                onClick={() => handleStart(app.id)}
              >
                <Upload className="mr-2 h-4 w-4" />
                {app.status === "RUNNING" ? t("Redeploy") : t("Deploy")}
              </DropdownMenuItem>
            )}

            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={deleteApp.isPending || app.status === "RUNNING"}
              onClick={() => handleDelete(app.id, app.name)}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t("Delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <TooltipProvider>
      <PageLayout
        title={t("Apps")}
        description={t("Manage your applications and services.")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {superAdmin && (
              <Button
                variant="outline"
                onClick={() => syncApps.mutate()}
                disabled={syncApps.isPending}
              >
                {syncApps.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                {syncApps.isPending ? t("Syncing…") : t("Sync Apps")}
              </Button>
            )}
            <Link to="/add-app">
            <Button className="bg-gradient-primary shadow-glow transition-all duration-300 hover:shadow-elegant">
              <Plus className="mr-2 h-4 w-4" />
              {t("Add App")}
              </Button>
            </Link>
          </div>
        }
      >
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(app) => app.id}
          query={query}
          pagination={applicationsData?.pagination}
          isLoading={isLoading}
          searchPlaceholder={t("Search name or domain…")}
          empty={t("No applications yet — deploy your first one.")}
          onRowClick={(app) => navigate(`/application/${app.id}`)}
          toolbar={
            // the imported-sites workflow: fifty unassigned rows, one owner —
            // while something is selected the bar is for that, not for filters
            superAdmin && selectedIds.length > 0 ? (
              <div className="flex items-center gap-2">
                <span className="whitespace-nowrap text-sm font-medium">
                  {t("{count} selected", { count: selectedIds.length })}
                </span>
                <OrganizationCombobox
                  value={bulkOrgId || null}
                  onChange={(id) => setBulkOrgId(id ?? "")}
                  placeholder={t("Assign to organization")}
                  className="w-56"
                />
                <Button
                  disabled={!bulkOrgId || bulkAssign.isPending}
                  onClick={() => bulkAssign.mutate({ ids: selectedIds, organizationId: bulkOrgId || null })}
                >
                  {bulkAssign.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t("Assign")}
                </Button>
                <Button variant="ghost" onClick={() => setSelectedIds([])}>
                  {t("Clear")}
                </Button>
              </div>
            ) : (
          <>
            <OrganizationFilter query={query} unassigned />
            <Select
              value={typeFilter || ALL}
              onValueChange={(v) => {
                setTypeFilter(v === ALL ? "" : v);
                query.setPage(1);
              }}
            >
              <SelectTrigger className="h-10 w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("All types")}</SelectItem>
                {Object.entries(APP_TYPES).map(([value, meta]) => (
                  <SelectItem key={value} value={value}>
                    {meta.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* an app on shop.example.com is under example.com */}
            {domainsWithApps.length > 1 && (
              <Select
                value={domainFilter || ALL}
                onValueChange={(v) => {
                  setDomainFilter(v === ALL ? "" : v);
                  query.setPage(1);
                }}
              >
                <SelectTrigger className="h-10 w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t("All domains")}</SelectItem>
                  {domainsWithApps.map((domain) => (
                    <SelectItem key={domain.id} value={domain.id}>
                      {domain.name}
                      <span className="ml-2 text-xs text-muted-foreground">{domain._count?.applications}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {superAdmin && (
              <Select
                value={serverFilter || ALL}
                onValueChange={(v) => {
                  setServerFilter(v === ALL ? "" : v);
                  query.setPage(1);
                }}
              >
                <SelectTrigger className="h-10 w-40">
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
                {t("Choose which organization owns {name}. Its members get to see and manage it.", { name: assignTarget?.name ?? "" })}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <OrganizationCombobox value={assignOrgId} onChange={setAssignOrgId} noneLabel={t("Unassigned")} />
              <div className="flex items-center justify-end space-x-3">
                <Button variant="outline" onClick={() => setAssignTarget(null)}>
                  {t("Cancel")}
                </Button>
                <Button
                  disabled={bulkAssign.isPending}
                  onClick={() =>
                    assignTarget && bulkAssign.mutate({ ids: [assignTarget.id], organizationId: assignOrgId })
                  }
                >
                  {bulkAssign.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t("Save")}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Confirmation Dialog */}
        {confirmAction && dialogContent && (
          <AlertDialog
            open={!!confirmAction}
            onOpenChange={() => setConfirmAction(null)}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{dialogContent.title}</AlertDialogTitle>
                <AlertDialogDescription>
                  {dialogContent.description}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={executeAction}
                  className={
                    dialogContent.variant === "destructive"
                      ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      : undefined
                  }
                  disabled={
                    startApp.isPending ||
                    stopApp.isPending ||
                    restartApp.isPending ||
                    deleteApp.isPending
                  }
                >
                  {startApp.isPending ||
                  stopApp.isPending ||
                  restartApp.isPending ||
                  deleteApp.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      {t("Processing...")}
                    </>
                  ) : (
                    dialogContent.actionText
                  )}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </PageLayout>
    </TooltipProvider>
  );
}
