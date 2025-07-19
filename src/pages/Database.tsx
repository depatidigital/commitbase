import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Database as DatabaseIcon, Plus, Search, Activity, HardDrive, Users } from "lucide-react";

const mockDatabases = [
  {
    id: 1,
    name: "production_db",
    type: "PostgreSQL",
    status: "active",
    size: "2.4GB",
    connections: 12,
    lastBackup: "2 hours ago"
  },
  {
    id: 2,
    name: "analytics_db",
    type: "MongoDB",
    status: "active",
    size: "890MB",
    connections: 3,
    lastBackup: "1 day ago"
  },
  {
    id: 3,
    name: "cache_redis",
    type: "Redis",
    status: "active",
    size: "156MB",
    connections: 8,
    lastBackup: "6 hours ago"
  }
];

export default function Database() {
  const [searchTerm, setSearchTerm] = useState("");

  const filteredDatabases = mockDatabases.filter(db =>
    db.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    db.type.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Database Management</h1>
          <p className="text-muted-foreground">
            Manage your databases and monitor their performance
          </p>
        </div>
        <Button className="bg-gradient-primary shadow-elegant">
          <Plus className="h-4 w-4 mr-2" />
          Create Database
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Databases</CardTitle>
            <DatabaseIcon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">3</div>
            <p className="text-xs text-muted-foreground">+0 from last month</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Storage Used</CardTitle>
            <HardDrive className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">3.4GB</div>
            <p className="text-xs text-muted-foreground">+180MB from last week</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Connections</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">23</div>
            <p className="text-xs text-muted-foreground">Across all databases</p>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center space-x-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search databases..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      <div className="grid gap-4">
        {filteredDatabases.map((database) => (
          <Card key={database.id}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="p-2 bg-gradient-primary rounded-lg shadow-glow">
                    <DatabaseIcon className="h-5 w-5 text-primary-foreground" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">{database.name}</CardTitle>
                    <CardDescription>{database.type}</CardDescription>
                  </div>
                </div>
                <Badge variant={database.status === "active" ? "default" : "secondary"}>
                  <Activity className="h-3 w-3 mr-1" />
                  {database.status}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">Size</p>
                  <p className="font-semibold">{database.size}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Connections</p>
                  <p className="font-semibold">{database.connections} active</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Last Backup</p>
                  <p className="font-semibold">{database.lastBackup}</p>
                </div>
              </div>
              <div className="flex space-x-2 mt-4">
                <Button variant="outline" size="sm">
                  Connect
                </Button>
                <Button variant="outline" size="sm">
                  Backup
                </Button>
                <Button variant="outline" size="sm">
                  Monitor
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}