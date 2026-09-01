import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, Database as DatabaseIcon } from "lucide-react";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { PageLayout } from "@/components/PageLayout";
import { OrganizationFilter } from "@/components/OrganizationFilter";
import { isAdmin } from "@/lib/auth";
import { DatabaseWithApplication, getAllDatabases } from "@/lib/databases";

const STATUS_DOT: Record<string, string> = {
  RUNNING: "bg-success",
  CREATING: "bg-warning",
  STOPPED: "bg-muted-foreground",
  ERROR: "bg-destructive",
};

export default function Database() {
  const query = useTableQuery();
  const admin = isAdmin();

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ["databases", query.params],
    queryFn: () => getAllDatabases(query.params),
  });

  const columns: Column<DatabaseWithApplication>[] = [
    {
      header: "Name",
      cell: (db) => <span className="font-medium">{db.name}</span>,
    },
    {
      header: "Type",
      cell: (db) => <Badge variant="secondary">{db.type}</Badge>,
    },
    {
      header: "Status",
      cell: (db) => (
        <div className="flex items-center space-x-2">
          <div
            className={`h-2 w-2 rounded-full ${STATUS_DOT[db.status] ?? "bg-muted-foreground"}`}
          />
          <span>{db.status}</span>
        </div>
      ),
    },
    ...(admin
      ? [
          {
            header: "Organization",
            cell: (db: DatabaseWithApplication) =>
              db.application?.organization ? (
                <Badge variant="outline">
                  {db.application.organization.name}
                </Badge>
              ) : (
                <span className="text-muted-foreground">—</span>
              ),
          },
        ]
      : []),
    {
      header: "Application",
      cell: (db) =>
        db.application ? (
          <Link
            to={`/application/${db.application.id}`}
            className="text-primary hover:underline"
          >
            {db.application.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    { header: "Version", cell: (db) => db.version || "—" },
    {
      header: "Created",
      cell: (db) => new Date(db.createdAt).toLocaleDateString(),
    },
  ];

  if (error) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-center">
          <AlertCircle className="mx-auto mb-4 h-12 w-12 text-destructive" />
          <h3 className="mb-2 text-lg font-semibold">
            Error loading databases
          </h3>
          <p className="mb-4 text-muted-foreground">
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
    <PageLayout
      icon={DatabaseIcon}
      title="Databases"
      description="Databases provisioned for your applications."
    >
      <DataTable
        columns={columns}
        rows={data?.data ?? []}
        rowKey={(db) => db.id}
        query={query}
        pagination={data?.pagination}
        isLoading={isFetching}
        searchPlaceholder="Search name or application…"
        toolbar={<OrganizationFilter query={query} />}
        empty="Databases are created from an application's detail page."
      />
    </PageLayout>
  );
}
