import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Terminal,
  Download,
  RefreshCw,
  Search,
  Filter,
  Calendar,
  AlertCircle,
  CheckCircle,
  Info
} from "lucide-react";

interface LogEntry {
  id: string;
  timestamp: string;
  level: "info" | "warn" | "error";
  app: string;
  message: string;
}

const mockLogs: LogEntry[] = [
  {
    id: "1",
    timestamp: "2024-01-15 14:32:15",
    level: "info",
    app: "api-server",
    message: "Server started on port 3000"
  },
  {
    id: "2", 
    timestamp: "2024-01-15 14:31:45",
    level: "info",
    app: "portfolio",
    message: "Static files served successfully"
  },
  {
    id: "3",
    timestamp: "2024-01-15 14:30:20",
    level: "error", 
    app: "dashboard",
    message: "Database connection failed: Connection timeout"
  },
  {
    id: "4",
    timestamp: "2024-01-15 14:29:10",
    level: "warn",
    app: "blog",
    message: "High memory usage detected: 85%"
  },
  {
    id: "5",
    timestamp: "2024-01-15 14:28:05",
    level: "info",
    app: "api-server", 
    message: "GET /api/users - 200 - 45ms"
  },
  {
    id: "6",
    timestamp: "2024-01-15 14:27:30",
    level: "error",
    app: "dashboard",
    message: "Failed to authenticate user: Invalid token"
  },
  {
    id: "7",
    timestamp: "2024-01-15 14:26:15",
    level: "info",
    app: "portfolio",
    message: "Build completed successfully in 2.3s"
  },
  {
    id: "8", 
    timestamp: "2024-01-15 14:25:00",
    level: "warn",
    app: "api-server",
    message: "Rate limit exceeded for IP 192.168.1.100"
  }
];

export default function Logs() {
  const [logs, setLogs] = useState(mockLogs);
  const [selectedApp, setSelectedApp] = useState("all");
  const [selectedLevel, setSelectedLevel] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);

  const apps = ["all", ...Array.from(new Set(mockLogs.map(log => log.app)))];
  const levels = ["all", "info", "warn", "error"];

  const filteredLogs = logs.filter(log => {
    const matchesApp = selectedApp === "all" || log.app === selectedApp;
    const matchesLevel = selectedLevel === "all" || log.level === selectedLevel;
    const matchesSearch = log.message.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         log.app.toLowerCase().includes(searchTerm.toLowerCase());
    
    return matchesApp && matchesLevel && matchesSearch;
  });

  const handleRefresh = () => {
    setIsRefreshing(true);
    setTimeout(() => {
      setIsRefreshing(false);
    }, 1000);
  };

  const getLevelIcon = (level: string) => {
    switch (level) {
      case "error":
        return <AlertCircle className="h-3 w-3" />;
      case "warn":
        return <AlertCircle className="h-3 w-3" />;
      case "info":
        return <CheckCircle className="h-3 w-3" />;
      default:
        return <Info className="h-3 w-3" />;
    }
  };

  const getLevelColor = (level: string) => {
    switch (level) {
      case "error":
        return "bg-destructive text-destructive-foreground";
      case "warn":
        return "bg-warning text-warning-foreground";
      case "info":
        return "bg-success text-success-foreground";
      default:
        return "bg-muted text-muted-foreground";
    }
  };

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-primary bg-clip-text text-transparent">
            Application Logs
          </h1>
          <p className="text-muted-foreground mt-1">
            Monitor and debug your applications
          </p>
        </div>
        
        <div className="flex items-center space-x-2">
          <Button
            variant="outline"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="hover:bg-muted"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button variant="outline" className="hover:bg-muted">
            <Download className="h-4 w-4 mr-2" />
            Export
          </Button>
        </div>
      </div>

      {/* Filters */}
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
              <label className="text-sm font-medium">Application</label>
              <Select value={selectedApp} onValueChange={setSelectedApp}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {apps.map(app => (
                    <SelectItem key={app} value={app}>
                      {app === "all" ? "All Applications" : app}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Log Level</label>
              <Select value={selectedLevel} onValueChange={setSelectedLevel}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {levels.map(level => (
                    <SelectItem key={level} value={level}>
                      {level === "all" ? "All Levels" : level.toUpperCase()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Search</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search logs..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Time Range</label>
              <Select defaultValue="1h">
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="15m">Last 15 minutes</SelectItem>
                  <SelectItem value="1h">Last 1 hour</SelectItem>
                  <SelectItem value="6h">Last 6 hours</SelectItem>
                  <SelectItem value="24h">Last 24 hours</SelectItem>
                  <SelectItem value="7d">Last 7 days</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Log Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="bg-gradient-card border-border/50 hover:shadow-elegant transition-all duration-300">
          <CardContent className="p-4">
            <div className="flex items-center space-x-2">
              <div className="p-2 bg-muted rounded-lg">
                <Terminal className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-medium">Total Logs</p>
                <p className="text-2xl font-bold">{filteredLogs.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-gradient-card border-border/50 hover:shadow-elegant transition-all duration-300">
          <CardContent className="p-4">
            <div className="flex items-center space-x-2">
              <div className="p-2 bg-destructive/10 rounded-lg">
                <AlertCircle className="h-4 w-4 text-destructive" />
              </div>
              <div>
                <p className="text-sm font-medium">Errors</p>
                <p className="text-2xl font-bold text-destructive">
                  {filteredLogs.filter(log => log.level === "error").length}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-gradient-card border-border/50 hover:shadow-elegant transition-all duration-300">
          <CardContent className="p-4">
            <div className="flex items-center space-x-2">
              <div className="p-2 bg-warning/10 rounded-lg">
                <AlertCircle className="h-4 w-4 text-warning" />
              </div>
              <div>
                <p className="text-sm font-medium">Warnings</p>
                <p className="text-2xl font-bold text-warning">
                  {filteredLogs.filter(log => log.level === "warn").length}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-gradient-card border-border/50 hover:shadow-elegant transition-all duration-300">
          <CardContent className="p-4">
            <div className="flex items-center space-x-2">
              <div className="p-2 bg-success/10 rounded-lg">
                <CheckCircle className="h-4 w-4 text-success" />
              </div>
              <div>
                <p className="text-sm font-medium">Info</p>
                <p className="text-2xl font-bold text-success">
                  {filteredLogs.filter(log => log.level === "info").length}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Logs Display */}
      <Card className="bg-gradient-card border-border/50 shadow-elegant">
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Terminal className="h-5 w-5 text-primary" />
            <span>Live Logs</span>
            {filteredLogs.length > 0 && (
              <Badge variant="secondary" className="ml-auto">
                {filteredLogs.length} entries
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="bg-slate-950 text-slate-50 font-mono text-sm rounded-b-lg">
            {filteredLogs.length === 0 ? (
              <div className="p-8 text-center text-slate-400">
                <Terminal className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No logs found matching your filters</p>
              </div>
            ) : (
              <div className="max-h-96 overflow-y-auto">
                {filteredLogs.map((log, index) => (
                  <div 
                    key={log.id}
                    className="flex items-start space-x-4 p-3 hover:bg-slate-900/50 border-b border-slate-800 last:border-0"
                    style={{ animationDelay: `${index * 0.05}s` }}
                  >
                    <div className="text-slate-400 text-xs min-w-[140px] font-medium">
                      {log.timestamp}
                    </div>
                    
                    <Badge 
                      variant="secondary"
                      className={`${getLevelColor(log.level)} text-xs min-w-[60px] justify-center`}
                    >
                      {getLevelIcon(log.level)}
                      <span className="ml-1">{log.level.toUpperCase()}</span>
                    </Badge>
                    
                    <Badge variant="outline" className="text-xs min-w-[100px] justify-center">
                      {log.app}
                    </Badge>
                    
                    <div className="flex-1 text-slate-100">
                      {log.message}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}