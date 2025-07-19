import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Globe,
  MoreVertical,
  Play,
  Square,
  RotateCcw,
  Trash2,
  ExternalLink,
  Activity,
  HardDrive,
  Cpu
} from "lucide-react";
import { cn } from "@/lib/utils";

import { App } from "@/types/app";

interface AppCardProps {
  app: App;
  onStart?: (id: string) => void;
  onStop?: (id: string) => void;
  onRestart?: (id: string) => void;
  onDelete?: (id: string) => void;
}

export function AppCard({ app, onStart, onStop, onRestart, onDelete }: AppCardProps) {
  const statusColors = {
    running: "bg-success text-success-foreground",
    stopped: "bg-muted text-muted-foreground",
    error: "bg-destructive text-destructive-foreground"
  };

  const statusIcons = {
    running: <Activity className="h-3 w-3" />,
    stopped: <Square className="h-3 w-3" />,
    error: <Activity className="h-3 w-3" />
  };

  return (
    <Card className="bg-gradient-card border-border/50 hover:shadow-elegant transition-all duration-300 group">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <CardTitle className="text-lg font-semibold group-hover:text-primary transition-colors">
              {app.name}
            </CardTitle>
            <div className="flex items-center space-x-2">
              <Globe className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{app.domain}</span>
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                <ExternalLink className="h-3 w-3" />
              </Button>
            </div>
          </div>
          
          <div className="flex items-center space-x-2">
            <Badge 
              variant="secondary" 
              className={cn("text-xs", statusColors[app.status])}
            >
              {statusIcons[app.status]}
              {app.status}
            </Badge>
            
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="bg-popover">
                {app.status === "stopped" ? (
                  <DropdownMenuItem onClick={() => onStart?.(app.id)}>
                    <Play className="h-4 w-4 mr-2" />
                    Start
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={() => onStop?.(app.id)}>
                    <Square className="h-4 w-4 mr-2" />
                    Stop
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => onRestart?.(app.id)}>
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Restart
                </DropdownMenuItem>
                <DropdownMenuItem 
                  onClick={() => onDelete?.(app.id)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>

      <CardContent className="py-4">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="space-y-2">
            <div className="flex items-center space-x-2">
              <Badge variant="outline" className="text-xs">
                {app.type}
              </Badge>
              {app.port && (
                <span className="text-muted-foreground">:{app.port}</span>
              )}
            </div>
            {app.uptime && (
              <div className="text-muted-foreground">
                Uptime: {app.uptime}
              </div>
            )}
          </div>
          
          <div className="space-y-2">
            {app.memory && (
              <div className="flex items-center space-x-1 text-muted-foreground">
                <HardDrive className="h-3 w-3" />
                <span>{app.memory}</span>
              </div>
            )}
            {app.cpu && (
              <div className="flex items-center space-x-1 text-muted-foreground">
                <Cpu className="h-3 w-3" />
                <span>{app.cpu}</span>
              </div>
            )}
          </div>
        </div>
      </CardContent>

      {app.lastDeployment && (
        <CardFooter className="pt-0 text-xs text-muted-foreground">
          Last deployed: {app.lastDeployment}
        </CardFooter>
      )}
    </Card>
  );
}