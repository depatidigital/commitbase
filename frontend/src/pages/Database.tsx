import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Database as DatabaseIcon,
  Search,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { getAllDatabases } from "@/lib/databases";

const STATUS_DOT: Record<string, string> = {
  RUNNING: "bg-success",
  CREATING: "bg-warning",
  STOPPED: "bg-muted-foreground",
  ERROR: "bg-destructive",
};

export default function Database() {
  const [searchTerm, setSearchTerm] = useState("");

  const {
    data: databases = [],
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["databases"],
    queryFn: getAllDatabases,
  });

  const filtered = databases.filter(
    (db) =>
      db.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      db.type.toLowerCase().includes(searchTerm.toLowerCase()) ||
      db.application?.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

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
          <h3 className="text-lg font-semibold mb-2">Error Loading Databases</h3>
          <p className="text-muted-foreground mb-4">
            {(error as Error).message}
          </p>
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
            Databases
          </h1>
          <p className="text-muted-foreground">
            Databases provisioned for your applications.
          </p>
        </div>
        <div className="flex items-center space-x-2 text-sm text-muted-foreground">
          <DatabaseIcon className="h-4 w-4 text-primary" />
          <span>{filtered.length} databases</span>
        </div>
      </div>

      <div className="relative max-w-md">
        <Label htmlFor="database-search" className="sr-only">
          Search databases
        </Label>
        <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
        <Input
          id="database-search"
          placeholder="Search by name, type or application..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-9"
        />
      </div>

      {filtered.length === 0 ? (
        <Card className="bg-gradient-card border-border/50">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <DatabaseIcon className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">
              {searchTerm ? "No matching databases" : "No Databases Yet"}
            </h3>
            <p className="text-muted-foreground text-center max-w-md mb-4">
              {searchTerm
                ? `Nothing matches "${searchTerm}".`
                : "Databases are created from an application's detail page."}
            </p>
            {searchTerm && (
              <Button variant="outline" onClick={() => setSearchTerm("")}>
                Clear search
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Application</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((database) => (
                <TableRow key={database.id}>
                  <TableCell className="font-medium">{database.name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{database.type}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center space-x-2">
                      <div
                        className={`w-2 h-2 rounded-full ${
                          STATUS_DOT[database.status] ?? "bg-muted-foreground"
                        }`}
                      />
                      <span>{database.status}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {database.application ? (
                      <Link
                        to={`/application/${database.application.id}`}
                        className="text-primary hover:underline"
                      >
                        {database.application.name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>{database.version || "—"}</TableCell>
                  <TableCell>
                    {new Date(database.createdAt).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
