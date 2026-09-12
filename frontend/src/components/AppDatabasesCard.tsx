import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Database as DatabaseIcon, FileUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DatabaseImportDialog } from "@/components/DatabaseImportDialog";
import { type AppDatabase, getAppDatabases } from "@/lib/databases";
import { t } from "@/lib/i18n";

const ENGINE_LABEL: Record<string, string> = { POSTGRESQL: "PostgreSQL", MYSQL: "MySQL" };

/**
 * The databases this app uses — linked to it, or named by its env — each with
 * an import. Nothing to show, nothing rendered: connecting one is done from
 * the Environment tab.
 */
export function AppDatabasesCard({ applicationId, applicationName }: { applicationId: string; applicationName: string }) {
  const [importing, setImporting] = useState<AppDatabase | null>(null);
  const { data: databases } = useQuery({
    queryKey: ["databases", "application", applicationId],
    queryFn: () => getAppDatabases(applicationId),
  });

  if (!databases?.length) return null;

  // the one its code talks to first
  const sorted = [...databases].sort((a, b) => Number(b.inUse) - Number(a.inUse));

  return (
    <Card className="bg-gradient-card border-border/50">
      <CardHeader className="pb-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <DatabaseIcon className="h-4 w-4 text-primary" />
          {t("Databases")}
        </CardTitle>
        <p className="text-xs text-muted-foreground">{t("What this app stores its data in")}</p>
      </CardHeader>
      <CardContent className="divide-y pt-2 pb-2">
        {sorted.map((db) => {
          const importable = !db.discovered && db.status === "RUNNING";
          return (
            <div key={db.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono">{db.dbName ?? db.name}</span>
                <Badge variant="secondary" className="text-xs">
                  {ENGINE_LABEL[db.type] ?? db.type}
                </Badge>
                {db.inUse && (
                  <Badge variant="outline" className="text-xs" title={t("Named in this app's environment variables")}>
                    {t("in use")}
                  </Badge>
                )}
                {db.status !== "RUNNING" && <span className="text-xs text-muted-foreground">{db.status.toLowerCase()}</span>}
              </div>
              {importable && (
                <Button variant="outline" size="sm" className="h-7" onClick={() => setImporting(db)}>
                  <FileUp className="mr-1.5 h-3.5 w-3.5" />
                  {t("Import SQL")}
                </Button>
              )}
            </div>
          );
        })}
      </CardContent>

      <DatabaseImportDialog
        database={importing && { ...importing, application: { name: applicationName } }}
        onClose={() => setImporting(null)}
      />
    </Card>
  );
}
