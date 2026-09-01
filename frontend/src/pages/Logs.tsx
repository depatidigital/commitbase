import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Terminal,
  Search,
  Filter,
  RefreshCw,
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  Info,
  Loader2,
  Download,
} from "lucide-react";
import { getSystemLogs, type SystemLog } from "@/lib/logs";

const ALL = "all";
const LEVELS = [ALL, "error", "warn", "info"] as const;
const LINE_OPTIONS = [100, 200, 500, 1000];

const levelIcon = (level: string) => {
  switch (level.toLowerCase()) {
    case "error":
    case "fatal":
      return <AlertCircle className="h-3 w-3" />;
    case "warn":
      return <AlertTriangle className="h-3 w-3" />;
    case "info":
      return <CheckCircle className="h-3 w-3" />;
    default:
      return <Info className="h-3 w-3" />;
  }
};

const levelColor = (level: string) => {
  switch (level.toLowerCase()) {
    case "error":
    case "fatal":
      return "bg-destructive text-destructive-foreground";
    case "warn":
      return "bg-warning text-warning-foreground";
    case "info":
      return "bg-success text-success-foreground";
    default:
      return "bg-muted text-muted-foreground";
  }
};

const toCsv = (logs: SystemLog[]) =>
  [
    "timestamp,level,application,message",
    ...logs.map((l) =>
      [
        l.timestamp,
        l.level,
        l.application?.name ?? "",
        `"${l.message.replace(/"/g, '""')}"`,
      ].join(",")
    ),
  ].join("\n");

export default function Logs() {
  const [selectedApp, setSelectedApp] = useState(ALL);
  const [selectedLevel, setSelectedLevel] = useState<(typeof LEVELS)[number]>(ALL);
  const [lines, setLines] = useState(200);
  const [searchTerm, setSearchTerm] = useState("");

  const {
    data: logs = [],
    isLoading,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: ["logs", "system", lines, selectedLevel],
    queryFn: () => getSystemLogs(lines, selectedLevel),
  });

  const apps = [
    ALL,
    ...Array.from(
      new Set(logs.map((l) => l.application?.name).filter((n): n is string => !!n))
    ),
  ];

  const filteredLogs = logs.filter((log) => {
    const appName = log.application?.name ?? "";
    const matchesApp = selectedApp === ALL || appName === selectedApp;
    const matchesSearch =
      log.message.toLowerCase().includes(searchTerm.toLowerCase()) ||
      appName.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesApp && matchesSearch;
  });

  const count = (level: string) =>
    logs.filter((l) => l.level.toLowerCase() === level).length;

  const handleExport = () => {
    const blob = new Blob([toCsv(filteredLogs)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `logs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-2">Error Loading Logs</h3>
          <p className="text-muted-foreground mb-4">{(error as Error).message}</p>
          <Button variant="outline" onClick={() => refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-primary bg-clip-text text-transparent">
            Application Logs
          </h1>
          <p className="text-muted-foreground mt-1">
            Monitor and debug your applications
          </p>
        </div>

        <div className="flex items-center space-x-2">
          <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw
              className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
          <Button
            variant="outline"
            onClick={handleExport}
            disabled={filteredLogs.length === 0}
          >
            <Download className="h-4 w-4 mr-2" />
            Export CSV
          </Button>
        </div>
      </div>

      <Card className="bg-gradient-card border-border/50 shadow-elegant">
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Filter className="h-5 w-5 text-primary" />
            <span>Filters</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="space-y-2">
              <Label htmlFor="log-app">Application</Label>
              <Select value={selectedApp} onValueChange={setSelectedApp}>
                <SelectTrigger id="log-app">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {apps.map((app) => (
                    <SelectItem key={app} value={app}>
                      {app === ALL ? "All Applications" : app}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="log-level">Level</Label>
              <Select
                value={selectedLevel}
                onValueChange={(v) => setSelectedLevel(v as (typeof LEVELS)[number])}
              >
                <SelectTrigger id="log-level">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {level === ALL ? "All Levels" : level.toUpperCase()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="log-search">Search</Label>
              <div className="relative">
                <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input
                  id="log-search"
                  placeholder="Search messages..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="log-lines">Lines</Label>
              <Select value={String(lines)} onValueChange={(v) => setLines(Number(v))}>
                <SelectTrigger id="log-lines">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LINE_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      Last {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Total", value: logs.length, icon: Terminal, tone: "text-primary" },
          { label: "Errors", value: count("error"), icon: AlertCircle, tone: "text-destructive" },
          { label: "Warnings", value: count("warn"), icon: AlertTriangle, tone: "text-warning" },
          { label: "Info", value: count("info"), icon: CheckCircle, tone: "text-success" },
        ].map((stat) => (
          <Card key={stat.label} className="bg-gradient-card border-border/50">
            <CardContent className="flex items-center justify-between p-4">
              <div>
                <p className="text-sm text-muted-foreground">{stat.label}</p>
                <p className="text-2xl font-bold">{stat.value}</p>
              </div>
              <stat.icon className={`h-5 w-5 ${stat.tone}`} />
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="bg-gradient-card border-border/50 shadow-elegant">
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Terminal className="h-5 w-5 text-primary" />
            <span>Log Entries ({filteredLogs.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {filteredLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Terminal className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-muted-foreground">
                {logs.length === 0
                  ? "No logs recorded yet."
                  : "No logs match the current filters."}
              </p>
            </div>
          ) : (
            <div className="max-h-[600px] overflow-auto space-y-1">
              {filteredLogs.map((log) => (
                <div
                  key={log.id}
                  className="flex items-start gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted/50"
                >
                  <span className="min-w-[150px] shrink-0 font-mono text-xs text-muted-foreground">
                    {new Date(log.timestamp).toLocaleString()}
                  </span>
                  <Badge
                    className={`${levelColor(log.level)} shrink-0 gap-1`}
                    variant="secondary"
                  >
                    {levelIcon(log.level)}
                    {log.level}
                  </Badge>
                  <Badge variant="outline" className="min-w-[110px] shrink-0 justify-center">
                    {log.application?.name ?? "platform"}
                  </Badge>
                  <span className="break-words">{log.message}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
