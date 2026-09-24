import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, CircleDashed, Globe, HardDrive, Loader2, Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { HeartbeatBar } from "@/components/HeartbeatBar";
import { locale, t } from "@/lib/i18n";
import { appStatus, getHostHealth, type HostHealth, type Tone } from "@/lib/health";
import { getDomainsPage } from "@/lib/domains";
import { expiryTone, needsRenewal } from "@/lib/domainExpiry";
import { isSuperAdmin } from "@/lib/auth";
import { getUsers } from "@/lib/admin";
import { diskUsedPct, getServers } from "@/lib/servers";
import { getProjects, type Project } from "@/lib/projects";
import { getUsage } from "@/lib/billing";
import { formatBytes } from "@/lib/utils";
import { DiskBar } from "@/components/DiskBar";

const TONE_TEXT: Record<Tone, string> = {
  up: "text-success",
  down: "text-destructive",
  warn: "text-warning",
  deploying: "text-warning",
  muted: "text-muted-foreground",
};

type Row = HostHealth & ReturnType<typeof appStatus>;

/** A count; coloured only when it is not zero, so a calm day looks calm. */
function Tile({ label, value, icon: Icon, tone = "", hint }: { label: string; value: number | string; icon: typeof Globe; tone?: string; hint?: string }) {
  const lit = value !== 0 && value !== "—" ? tone : "";
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-5">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className={`text-2xl font-semibold ${lit}`}>{value}</p>
          {hint && <p className="truncate text-xs text-muted-foreground" title={hint}>{hint}</p>}
        </div>
        <Icon className={`h-6 w-6 shrink-0 ${lit || "text-muted-foreground"}`} />
      </CardContent>
    </Card>
  );
}

/**
 * The landing page, and the monitor: is everything healthy? Every hostname
 * (each binding: host + path) with its own uptime checks, worst first, and the
 * domains running out. It only watches — acting is on the app's page.
 */
export default function Dashboard() {
  const navigate = useNavigate();
  const query = useTableQuery(25);
  const superAdmin = isSuperAdmin();

  // every hostname of the workspace, each with its own checks — on the rhythm they are written
  const { data = [], isLoading } = useQuery({ queryKey: ["hosts", "health"], queryFn: getHostHealth, refetchInterval: 60_000 });

  // soonest first; expired sort before the rest, undated last
  const { data: domainsPage } = useQuery({
    queryKey: ["domains", "dashboard"],
    queryFn: () => getDomainsPage({ page: 1, limit: 20, search: "", sort: "expiresAt", order: "asc" }),
  });
  const renewals = (domainsPage?.data ?? []).filter(needsRenewal);

  // platform-wide count: superadmin only
  const { data: usersPage } = useQuery({
    queryKey: ["users", "dashboard"],
    queryFn: () => getUsers({ page: 1, limit: 1, search: "" }),
    enabled: superAdmin,
  });

  // every server's disk, fullest first — which one wants a cleanup (superadmin)
  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: getServers, enabled: superAdmin, refetchInterval: 60_000 });
  const disks = servers.filter((server) => server.disk).sort((a, b) => diskUsedPct(b.disk) - diskUsedPct(a.disk));

  // what the workspace stores, largest app first — disk, R2 and (for its owners) its journal logs
  // ponytail: the first 100 apps (the API's page cap) make the total; a summary endpoint past that
  const { data: byDisk } = useQuery({
    queryKey: ["projects", "dashboard-disk"],
    queryFn: () => getProjects({ page: 1, limit: 100, search: "", sort: "disk", order: "desc" }),
    refetchInterval: 5 * 60_000,
  });
  // the journal is measured per workspace, on the Biaya page — its owners and admins only; others see apps alone
  const { data: usage } = useQuery({ queryKey: ["billing", "usage", "dashboard"], queryFn: () => getUsage(), retry: false });
  const sizeOf = (project: Project) => project.applications.reduce((sum, app) => sum + (app.diskBytes ?? 0), 0);
  // a static site the panel deployed is in R2, everything else on a node's disk
  const inR2 = (app: Project["applications"][number]) => app.type === "STATIC" && !app.runtime;
  const apps = byDisk?.data ?? [];
  const r2Bytes = apps.reduce((sum, p) => sum + p.applications.filter(inR2).reduce((s2, a) => s2 + (a.diskBytes ?? 0), 0), 0);
  const appsBytes = apps.reduce((sum, p) => sum + sizeOf(p), 0);
  const journalBytes = (usage?.rate?.journalGb ?? 0) * 1024 ** 3;

  const rows: Row[] = data
    .map((row) => ({ ...row, ...appStatus(row.service.status, row.health, row.service.disabled) }))
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  const count = (test: (row: Row) => boolean) => rows.filter(test).length;

  const columns: Column<Row>[] = [
    {
      header: t("Host"),
      className: "w-[34%]",
      cell: ({ host, path, app, service }) => (
        <div className="min-w-0">
          <span className="block truncate font-medium">
            {host}
            {path && <span className="font-mono text-xs text-muted-foreground">{path}</span>}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{app ? `${app.name} · ${service.name}` : service.name}</span>
        </div>
      ),
    },
    {
      header: t("Status"),
      className: "w-40",
      cell: ({ text, tone, health }) => (
        <div className="min-w-0">
          <span className={`flex items-center gap-1.5 text-sm font-medium ${TONE_TEXT[tone]}`}>
            {tone === "deploying" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <span className="h-2 w-2 rounded-full bg-current" />}
            {text}
          </span>
          {health?.state !== "up" && health?.lastError && (
            <span className="block truncate text-xs text-destructive" title={health.lastError}>
              {health.lastError}
            </span>
          )}
        </div>
      ),
    },
    {
      header: t("Last 30 checks"),
      className: "w-48",
      cell: ({ health }) => <HeartbeatBar health={health} />,
    },
    {
      header: t("Uptime 24h"),
      className: "w-28 text-right",
      cell: ({ health, tone }) =>
        health?.uptime24h != null ? (
          <span className={tone === "down" ? "font-medium text-destructive" : ""}>{health.uptime24h}%</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      header: t("Response"),
      className: "w-24 text-right",
      cell: ({ health }) =>
        health?.responseMs != null ? <span className="text-sm">{health.responseMs} ms</span> : <span className="text-muted-foreground">—</span>,
    },
  ];

  return (
    <PageLayout title={t("Dashboard")} description={t("Uptime of every hostname, checked every minute.")}>
      <div className={`grid grid-cols-2 gap-4 ${superAdmin ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}>
        <Tile label={t("Online")} value={count((row) => row.tone === "up")} icon={CheckCircle2} tone="text-success" />
        <Tile label={t("Need attention")} value={count((row) => row.tone === "down" || row.tone === "warn")} icon={AlertTriangle} tone="text-destructive" />
        <Tile label={t("Not monitored")} value={count((row) => row.tone === "muted")} icon={CircleDashed} />
        <Tile
          label={t("Storage (all apps)")}
          value={byDisk ? formatBytes(appsBytes + journalBytes, locale) : "—"}
          icon={HardDrive}
          hint={
            t("Disk {disk} · R2 {r2}", { disk: formatBytes(appsBytes - r2Bytes, locale), r2: formatBytes(r2Bytes, locale) }) +
            (journalBytes > 0 ? ` · ${t("Journal logs {size}", { size: formatBytes(journalBytes, locale) })}` : "")
          }
        />
        {superAdmin && <Tile label={t("Total users")} value={usersPage?.pagination.total ?? "—"} icon={Users} />}
      </div>

      {/* bento: the monitor wide — it matters most — domains and servers beside it */}
      <div className="grid items-start gap-4 lg:grid-cols-3">
      <div className="min-w-0 lg:col-span-2">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          query={query}
          isLoading={isLoading}
          searchPlaceholder={t("Search hostname, app or service…")}
          filter={(row, search) => `${row.id} ${row.app?.name ?? ""} ${row.service.name}`.toLowerCase().includes(search.toLowerCase())}
          empty={t("No hostnames yet.")}
          onRowClick={(row) => navigate(`/services/${row.service.id}`)}
        />
      </div>
      <div className="space-y-4">
      {/* the count and its list in one card */}
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe className="h-4 w-4" />
              {t("Domains to renew")}
            </CardTitle>
            <p className={`text-2xl font-semibold ${renewals.length ? "text-warning" : ""}`}>{renewals.length}</p>
          </CardHeader>
          <CardContent>
            {renewals.length === 0 && <p className="text-sm text-muted-foreground">{t("No domain expires within 30 days.")}</p>}
            <ul className="divide-y">
              {renewals.map((domain) => {
                const tone = expiryTone(new Date(domain.expiresAt!));
                return (
                  <li key={domain.id}>
                    <Link to={`/domains/${domain.id}`} className="flex items-center gap-2 py-2 text-sm hover:text-primary">
                      <span className="min-w-0 flex-1 truncate font-medium">{domain.name}</span>
                      <span className={`shrink-0 text-xs ${tone.className}`}>{tone.note}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>


      {superAdmin && disks.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <HardDrive className="h-4 w-4" />
              {t("Server storage")}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
            {disks.map((server) => (
              <div key={server.id} className="min-w-0 space-y-1.5">
                <Link to={`/servers/${server.id}`} className="block truncate text-sm font-medium hover:text-primary">
                  {server.name}
                </Link>
                <DiskBar serverId={server.id} disk={server.disk} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      </div>
      </div>
    </PageLayout>
  );
}
