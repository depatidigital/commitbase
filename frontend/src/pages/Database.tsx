import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Database as DatabaseIcon, Plus, Search, Activity, HardDrive, Users, ExternalLink, Download, BarChart3 } from "lucide-react";

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
    <div className="space-y-8 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-primary bg-clip-text text-transparent">
            Database
          </h1>
          <p className="text-muted-foreground">
            Manage your databases and monitor their performance.
          </p>
        </div>
        <Button className="bg-gradient-primary shadow-glow hover:shadow-elegant transition-all duration-300">
          <Plus className="h-4 w-4 mr-2" />
          Create Database
        </Button>
      </div>

      {/* Search */}
      <div className="flex items-center space-x-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search databases..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Database Table */}
      <div className="space-y-6">
        {filteredDatabases.length === 0 ? (
          <Card className="bg-gradient-card border-border/50">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <DatabaseIcon className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">No Databases Yet</h3>
              <p className="text-muted-foreground text-center max-w-md mb-4">
                Get started by creating your first database.
              </p>
              <Button className="bg-gradient-primary">
                <Plus className="h-4 w-4 mr-2" />
                Create Your First Database
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Connections</TableHead>
                  <TableHead>Last Backup</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredDatabases.map((database) => (
                  <TableRow key={database.id}>
                    <TableCell className="font-medium">{database.name}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                        {database.type}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center space-x-2">
                        <div className={`w-2 h-2 rounded-full ${
                          database.status === 'active' ? 'bg-green-500' : 'bg-gray-500'
                        }`} />
                        <span className="capitalize">{database.status}</span>
                      </div>
                    </TableCell>
                    <TableCell>{database.size}</TableCell>
                    <TableCell>{database.connections} active</TableCell>
                    <TableCell>{database.lastBackup}</TableCell>
                    <TableCell>
                      <div className="flex items-center space-x-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 w-8 p-0"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 w-8 p-0"
                        >
                          <Download className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 w-8 p-0"
                        >
                          <BarChart3 className="h-4 w-4" />
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