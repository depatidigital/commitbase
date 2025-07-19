import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AppCard } from "@/components/AppCard";
import { App } from "@/types/app";
import { 
  Server, 
  Plus, 
  Activity, 
  AlertCircle,
  Zap,
  Globe,
  HardDrive,
  Cpu
} from "lucide-react";
import { Link } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";

// Mock data - in real app this would come from API
const mockApps: App[] = [
  {
    id: "1",
    name: "Portfolio Website",
    domain: "portfolio.yourdomain.com",
    type: "static",
    status: "running",
    uptime: "2d 14h",
    lastDeployment: "2 hours ago"
  },
  {
    id: "2", 
    name: "API Server",
    domain: "api.yourdomain.com",
    type: "nodejs",
    status: "running",
    port: 3000,
    memory: "45MB",
    cpu: "2%",
    uptime: "5d 8h",
    lastDeployment: "1 day ago"
  },
  {
    id: "3",
    name: "Blog",
    domain: "blog.yourdomain.com", 
    type: "nodejs",
    status: "stopped",
    port: 3001,
    memory: "0MB",
    cpu: "0%",
    lastDeployment: "3 days ago"
  },
  {
    id: "4",
    name: "Dashboard",
    domain: "admin.yourdomain.com",
    type: "nodejs",
    status: "error",
    port: 3002,
    memory: "12MB",
    cpu: "0%",
    uptime: "0m",
    lastDeployment: "5 hours ago"
  }
];

const systemStats = {
  totalApps: 4,
  runningApps: 2,
  totalMemory: "4GB",
  usedMemory: "1.2GB",
  cpuUsage: "15%",
  diskUsage: "45%"
};

export default function Dashboard() {
  const [apps, setApps] = useState(mockApps);
  const { toast } = useToast();

  const handleStart = (id: string) => {
    setApps(prev => prev.map(app => 
      app.id === id ? { ...app, status: "running" as const } : app
    ));
    toast({
      title: "App Started",
      description: "Application has been started successfully.",
    });
  };

  const handleStop = (id: string) => {
    setApps(prev => prev.map(app => 
      app.id === id ? { ...app, status: "stopped" as const } : app
    ));
    toast({
      title: "App Stopped", 
      description: "Application has been stopped.",
    });
  };

  const handleRestart = (id: string) => {
    toast({
      title: "App Restarting",
      description: "Application is being restarted...",
    });
    // Simulate restart
    setTimeout(() => {
      setApps(prev => prev.map(app => 
        app.id === id ? { ...app, status: "running" as const } : app
      ));
      toast({
        title: "App Restarted",
        description: "Application has been restarted successfully.",
      });
    }, 2000);
  };

  const handleDelete = (id: string) => {
    setApps(prev => prev.filter(app => app.id !== id));
    toast({
      title: "App Deleted",
      description: "Application has been removed from the platform.",
      variant: "destructive"
    });
  };

  const runningApps = apps.filter(app => app.status === "running").length;
  const errorApps = apps.filter(app => app.status === "error").length;

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-primary bg-clip-text text-transparent">
            Deploy Dashboard
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage your self-hosted applications
          </p>
        </div>
        <Link to="/add-app">
          <Button className="bg-gradient-primary shadow-glow hover:shadow-elegant transition-all duration-300">
            <Plus className="h-4 w-4 mr-2" />
            Deploy New App
          </Button>
        </Link>
      </div>

      {/* System Overview */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card className="bg-gradient-card border-border/50 hover:shadow-elegant transition-all duration-300">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Apps</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{systemStats.totalApps}</div>
            <p className="text-xs text-muted-foreground">
              {runningApps} running, {errorApps} errors
            </p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-card border-border/50 hover:shadow-elegant transition-all duration-300">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Memory Usage</CardTitle>
            <HardDrive className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{systemStats.usedMemory}</div>
            <p className="text-xs text-muted-foreground">
              of {systemStats.totalMemory} total
            </p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-card border-border/50 hover:shadow-elegant transition-all duration-300">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">CPU Usage</CardTitle>
            <Cpu className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{systemStats.cpuUsage}</div>
            <p className="text-xs text-muted-foreground">
              Average load
            </p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-card border-border/50 hover:shadow-elegant transition-all duration-300">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Platform Status</CardTitle>
            <Activity className="h-4 w-4 text-success animate-pulse" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-success">Online</div>
            <p className="text-xs text-muted-foreground">
              All systems operational
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Apps Section */}
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold">Applications</h2>
          <div className="flex items-center space-x-2 text-sm text-muted-foreground">
            <Activity className="h-4 w-4 text-success" />
            <span>{runningApps} running</span>
            {errorApps > 0 && (
              <>
                <AlertCircle className="h-4 w-4 text-destructive ml-4" />
                <span>{errorApps} errors</span>
              </>
            )}
          </div>
        </div>

        {apps.length === 0 ? (
          <Card className="bg-gradient-card border-border/50">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Zap className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">No Applications Yet</h3>
              <p className="text-muted-foreground text-center max-w-md mb-4">
                Get started by deploying your first application to the platform.
              </p>
              <Link to="/add-app">
                <Button className="bg-gradient-primary">
                  <Plus className="h-4 w-4 mr-2" />
                  Deploy Your First App
                </Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {apps.map((app, index) => (
              <div 
                key={app.id} 
                className="animate-slide-up"
                style={{ animationDelay: `${index * 0.1}s` }}
              >
                <AppCard
                  app={app}
                  onStart={handleStart}
                  onStop={handleStop}
                  onRestart={handleRestart}
                  onDelete={handleDelete}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}