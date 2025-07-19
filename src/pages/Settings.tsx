import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Settings as SettingsIcon, Server, Shield, Bell } from "lucide-react";

export default function Settings() {
  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h1 className="text-3xl font-bold bg-gradient-primary bg-clip-text text-transparent">
          Platform Settings
        </h1>
        <p className="text-muted-foreground mt-1">
          Configure your deployment platform
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="bg-gradient-card border-border/50 hover:shadow-elegant transition-all duration-300">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Server className="h-5 w-5 text-primary" />
              <span>Server Config</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">Configure server settings, domains, and SSL</p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-card border-border/50 hover:shadow-elegant transition-all duration-300">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Shield className="h-5 w-5 text-primary" />
              <span>Security</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">Manage authentication and access controls</p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-card border-border/50 hover:shadow-elegant transition-all duration-300">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Bell className="h-5 w-5 text-primary" />
              <span>Notifications</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">Configure alerts and monitoring</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}