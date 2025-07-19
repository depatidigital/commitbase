import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { 
  Server, 
  Plus, 
  Activity, 
  AlertCircle,
  Zap,
  Globe,
  HardDrive,
  Cpu,
  Play,
  Square,
  RotateCcw,
  Trash2,
  Search,
  Loader2
} from "lucide-react";
import { Link } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { useApplications, useStartApplication, useStopApplication, useRestartApplication, useDeleteApplication } from "@/hooks/useApplications";

export default function Application() {
  const [searchTerm, setSearchTerm] = useState("");
  const { toast } = useToast();
  
  // API hooks
  const { data: applicationsData, isLoading, error } = useApplications();
  const startApp = useStartApplication();
  const stopApp = useStopApplication();
  const restartApp = useRestartApplication();
  const deleteApp = useDeleteApplication();

  const applications = applicationsData?.data || [];
  const filteredApps = applications.filter(app =>
    app.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    app.domain.toLowerCase().includes(searchTerm.toLowerCase()) ||
    app.type.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleStart = async (id: string) => {
    try {
      await startApp.mutateAsync(id);
    } catch (error) {
      // Error is handled by the mutation
    }
  };

  const handleStop = async (id: string) => {
    try {
      await stopApp.mutateAsync(id);
    } catch (error) {
      // Error is handled by the mutation
    }
  };

  const handleRestart = async (id: string) => {
    try {
      await restartApp.mutateAsync(id);
    } catch (error) {
      // Error is handled by the mutation
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteApp.mutateAsync(id);
    } catch (error) {
      // Error is handled by the mutation
    }
  };

  const runningApps = filteredApps.filter(app => app.status === "RUNNING").length;
  const errorApps = filteredApps.filter(app => app.status === "ERROR").length;

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
          <h3 className="text-lg font-semibold mb-2">Error Loading Applications</h3>
          <p className="text-muted-foreground">Failed to load applications. Please try again.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-primary bg-clip-text text-transparent">
            Applications
          </h1>
          <p className="text-muted-foreground">
            Manage your applications and services.
          </p>
        </div>
        <Link to="/add-app">
          <Button className="bg-gradient-primary shadow-glow hover:shadow-elegant transition-all duration-300">
            <Plus className="h-4 w-4 mr-2" />
            Deploy New App
          </Button>
        </Link>
      </div>

      {/* Search */}
      <div className="flex items-center space-x-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search applications..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9"
          />
        </div>
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

      {/* Apps Section */}
      <div className="space-y-6">
        {filteredApps.length === 0 ? (
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
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Domain</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Port</TableHead>
                  <TableHead>Last Deployment</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredApps.map((app) => (
                  <TableRow key={app.id}>
                    <TableCell className="font-medium">{app.name}</TableCell>
                    <TableCell>
                      <div className="flex items-center space-x-2">
                        <Globe className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm">{app.domain}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                        {app.type}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center space-x-2">
                        <div className={`w-2 h-2 rounded-full ${
                          app.status === 'RUNNING' ? 'bg-green-500' : 
                          app.status === 'STOPPED' ? 'bg-gray-500' : 
                          app.status === 'ERROR' ? 'bg-red-500' :
                          app.status === 'DEPLOYING' ? 'bg-yellow-500' :
                          'bg-blue-500'
                        }`} />
                        <span className="capitalize">{app.status.toLowerCase()}</span>
                      </div>
                    </TableCell>
                    <TableCell>{app.port || '-'}</TableCell>
                    <TableCell>
                      {app.deployments && app.deployments.length > 0 
                        ? new Date(app.deployments[0].createdAt).toLocaleDateString()
                        : '-'
                      }
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center space-x-2">
                        {app.status === 'RUNNING' ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleStop(app.id)}
                            disabled={stopApp.isPending}
                            className="h-8 w-8 p-0"
                          >
                            {stopApp.isPending ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Square className="h-4 w-4" />
                            )}
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleStart(app.id)}
                            disabled={startApp.isPending}
                            className="h-8 w-8 p-0"
                          >
                            {startApp.isPending ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Play className="h-4 w-4" />
                            )}
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRestart(app.id)}
                          disabled={restartApp.isPending}
                          className="h-8 w-8 p-0"
                        >
                          {restartApp.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <RotateCcw className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleDelete(app.id)}
                          disabled={deleteApp.isPending}
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                        >
                          {deleteApp.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}