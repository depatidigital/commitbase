import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, CheckCircle2, CircleDashed, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { HeartbeatBar } from "@/components/HeartbeatBar";
import { t } from "@/lib/i18n";
import { appStatus, getHostHealth, type HostHealth, type Tone } from "@/lib/health";

const TONE_TEXT: Record<Tone, string> = {
  up: "text-success",
  down: "text-destructive",
  warn: "text-warning",
  deploying: "text-warning",
  muted: "text-muted-foreground",
};

type Row = HostHealth & ReturnType<typeof appStatus>;

function Tile({ label, value, icon: Icon, tone }: { label: string; value: number; icon: typeof Activity; tone: string }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-5">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className={`text-2xl font-semibold ${value ? tone : ""}`}>{value}</p>
        </div>
        <Icon className={`h-6 w-6 ${value ? tone : "text-muted-foreground"}`} />
      </CardContent>
    </Card>
  );
}

/**
 * Is everything up — and what is not, since when. One row per hostname (each
 * binding: host + path) with its own uptime checks, worst first. Starting, stopping and deploying live on the
 * app's page; this page only watches.
 */
export default function Monitor() {
  const navigate = useNavigate();
  const query = useTableQuery(25);

  // every hostname of the workspace, each with its own checks — on the rhythm they are written
  const { data = [], isLoading } = useQuery({ queryKey: ["hosts", "health"], queryFn: getHostHealth, refetchInterval: 60_000 });

  const rows: Row[] = data
    .map((row) => ({ ...row, ...appStatus(row.service.status, row.health, row.service.disabled) }))
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));

  const count = (test: (row: Row) => boolean) => rows.filter(test).length;
  const online = count((row) => row.tone === "up");
  const trouble = count((row) => row.tone === "down" || row.tone === "warn");
  const unwatched = count((row) => row.tone === "muted");

  const columns: Column<Row>[] = [
    {
      header: t("Host"),
      className: "w-[30%]",
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
      className: "w-36",
      cell: ({ text, tone }) => (
        <span className={`flex items-center gap-1.5 text-sm font-medium ${TONE_TEXT[tone]}`}>
          {tone === "deploying" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <span className="h-2 w-2 rounded-full bg-current" />}
          {text}
        </span>
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
    {
      header: t("Last error"),
      cell: ({ health }) =>
        health?.state !== "up" && health?.lastError ? (
          <span className="block truncate text-xs text-destructive" title={health.lastError}>
            {health.lastError}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ];

  return (
    <PageLayout icon={Activity} title={t("Monitor")} description={t("Uptime of every hostname, checked every minute.")}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Tile label={t("Online")} value={online} icon={CheckCircle2} tone="text-success" />
        <Tile label={t("Need attention")} value={trouble} icon={AlertTriangle} tone="text-destructive" />
        <Tile label={t("Not monitored")} value={unwatched} icon={CircleDashed} tone="text-muted-foreground" />
      </div>

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
    </PageLayout>
  );
}
