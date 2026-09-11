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
import { locale, t } from "@/lib/i18n";

const STATUS_DOT: Record<string, string> = {
  RUNNING: "bg-success",
  CREATING: "bg-warning",
  STOPPED: "bg-muted-foreground",
  ERROR: "bg-destructive",
};

const STATUS_LABEL: Record<string, string> = {
  RUNNING: t("Running"),
  CREATING: t("Creating"),
  STOPPED: t("Stopped"),
  ERROR: t("Error"),
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
      header: t("Name"),
      className: "w-[22%]",
      cell: (db) => (
        <span className="block truncate font-medium">{db.name}</span>
      ),
    },
    {
      header: t("Type"),
      className: "w-28",
      cell: (db) => <Badge variant="secondary">{db.type}</Badge>,
    },
    {
      header: t("Status"),
      className: "w-32",
      cell: (db) => (
        <div className="flex items-center space-x-2">
          <div
            className={`h-2 w-2 rounded-full ${STATUS_DOT[db.status] ?? "bg-muted-foreground"}`}
          />
          <span>{STATUS_LABEL[db.status] ?? db.status}</span>
        </div>
      ),
    },
    ...(admin
      ? [
          {
            header: t("Organization"),
            className: "w-[20%]",
            cell: (db: DatabaseWithApplication) => {
              const organization = db.organization ?? db.application?.organization;
              return organization ? (
                <Badge variant="outline" className="max-w-full truncate">
                  {organization.name}
                </Badge>
              ) : (
                <span className="text-muted-foreground">{t("Unassigned")}</span>
              );
            },
          },
        ]
      : []),
    {
      header: t("App"),
      className: "w-[18%]",
      cell: (db) =>
        db.application ? (
          <Link
            to={`/application/${db.application.id}`}
            className="block truncate text-primary hover:underline"
          >
            {db.application.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    { header: t("Version"), className: "w-24", cell: (db) => db.version || "—" },
    {
      header: t("Created"),
      className: "w-28 text-xs",
      cell: (db) => new Date(db.createdAt).toLocaleDateString(locale),
    },
  ];

  if (error) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-center">
          <AlertCircle className="mx-auto mb-4 h-12 w-12 text-destructive" />
          <h3 className="mb-2 text-lg font-semibold">
            {t("Error loading databases")}
          </h3>
          <p className="mb-4 text-muted-foreground">
            {(error as Error).message}
          </p>
          <Button variant="outline" onClick={() => refetch()}>
            {t("Try again")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <PageLayout
      icon={DatabaseIcon}
      title={t("Databases")}
      description={t("Databases provisioned for your applications.")}
    >
      <DataTable
        columns={columns}
        rows={data?.data ?? []}
        rowKey={(db) => db.id}
        query={query}
        pagination={data?.pagination}
        isLoading={isFetching}
        searchPlaceholder={t("Search name or application…")}
        toolbar={<OrganizationFilter query={query} />}
        empty={t("Databases are created from an application's detail page.")}
      />
    </PageLayout>
  );
}
