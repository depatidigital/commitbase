import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Database as DatabaseIcon, Download, History, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DatabaseImportDialog } from "@/components/DatabaseImportDialog";
import { useToast } from "@/hooks/use-toast";
import { type AppDatabase, downloadDatabaseBackup, getAppDatabases, getProjectDatabases } from "@/lib/databases";
import { locale, t } from "@/lib/i18n";

const ENGINE_LABEL: Record<string, string> = { POSTGRESQL: "PostgreSQL", MYSQL: "MySQL" };

const STATUS_DOT: Record<string, string> = {
  RUNNING: "bg-success",
  CREATING: "bg-warning",
  STOPPED: "bg-muted-foreground",
  ERROR: "bg-destructive",
};

const size = (bytes?: number | null) => {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString(locale, { maximumFractionDigits: unit < 2 ? 0 : 1 })} ${units[unit]}`;
};

/**
 * The Database tab, of an app or (`projectId`) of a project: the databases
 * used — linked, or named by the env (`inUse`, the one the code talks to; a
 * project's say which of its apps use each, often all of them) — and restoring
 * one from a .sql dump. Connecting opens the app's Environment form dialog
 * (`onConnect`), so the URL merges with any unsaved env edits; a project
 * connects from each app's Environment.
 */
export function AppDatabasesTab({
  applicationId,
  applicationName,
  projectId,
  onConnect,
}: {
  applicationId?: string;
  applicationName?: string;
  projectId?: string;
  onConnect?: () => void;
}) {
  const [restoring, setRestoring] = useState<AppDatabase | null>(null);
  const { toast } = useToast();
  const backup = useMutation({
    mutationFn: (db: AppDatabase) => downloadDatabaseBackup(db.id),
    onError: (error: Error) => toast({ variant: "destructive", title: t("Backup failed"), description: error.message }),
  });
  const { data: databases, isLoading, error } = useQuery({
    queryKey: projectId ? ["databases", "project", projectId] : ["databases", "application", applicationId],
    queryFn: () => (projectId ? getProjectDatabases(projectId) : getAppDatabases(applicationId!)),
  });

  // the ones the code talks to first
  const used = (db: AppDatabase) => (db.usedBy ? db.usedBy.length : Number(!!db.inUse));
  const sorted = [...(databases ?? [])].sort((a, b) => used(b) - used(a));

  return (
    <Card className="bg-gradient-card border-border/50">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <DatabaseIcon className="h-5 w-5 text-primary" />
            {t("Database")}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {projectId ? t("What the apps of this project store their data in") : t("What this app stores its data in")}
          </p>
        </div>
        {!!sorted.length && onConnect && (
          <Button variant="outline" size="sm" onClick={onConnect}>
            {t("Change database")}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Loader2 className="mx-auto my-6 h-5 w-5 animate-spin" />
        ) : error ? (
          <p className="text-sm text-destructive">{(error as Error).message}</p>
        ) : !sorted.length ? (
          <div className="rounded-md border border-dashed p-6 text-center">
            {projectId ? (
              <p className="text-sm text-muted-foreground">{t("No app of this project uses a database yet — connect one from an app's Environment tab.")}</p>
            ) : (
              <>
                <p className="mb-3 text-sm text-muted-foreground">{t("No database connected to this app yet.")}</p>
                {onConnect && (
                  <Button variant="outline" onClick={onConnect}>
                    {t("Connect a database")}
                  </Button>
                )}
              </>
            )}
          </div>
        ) : (
          sorted.map((db) => {
            // one found on its server is reached as the login its app's .env names — so only once it is linked to an app (this one)
            const restorable = db.status === "RUNNING" && (!db.discovered || (projectId ? !!db.applicationId : db.applicationId === applicationId));
            return (
              <div key={db.id} className="rounded-md border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-mono font-medium">{db.dbName ?? db.name}</span>
                      <Badge variant="secondary" className="text-xs">
                        {ENGINE_LABEL[db.type] ?? db.type}
                      </Badge>
                      {db.inUse && (
                        <Badge variant="outline" className="text-xs" title={t("Named in this app's environment variables")}>
                          {t("in use")}
                        </Badge>
                      )}
                    </div>
                    {/* a project's: which of its apps talk to it — named in their env */}
                    {db.usedBy && (
                      <p className="text-xs text-muted-foreground">
                        {db.usedBy.length
                          ? t("Used by {apps}", { apps: db.usedBy.map((app) => app.name).join(", ") })
                          : t("No app's environment names it")}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <span className={`h-2 w-2 rounded-full ${STATUS_DOT[db.status] ?? "bg-muted-foreground"}`} />
                        {db.status.toLowerCase()}
                      </span>
                      <span>
                        {t("Size")}: {size(db.sizeBytes)}
                      </span>
                      <span>
                        {t("Created")}: {new Date(db.createdAt).toLocaleDateString(locale)}
                      </span>
                    </div>
                    {db.lastError && <p className="text-xs text-destructive">{db.lastError}</p>}
                  </div>
                  {restorable && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={backup.isPending}
                        onClick={() => backup.mutate(db)}
                      >
                        {backup.isPending && backup.variables?.id === db.id ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        {t("Download backup")}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setRestoring(db)}>
                        <History className="mr-1.5 h-3.5 w-3.5" />
                        {t("Restore DB (.sql)")}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </CardContent>

      <DatabaseImportDialog
        database={restoring && { ...restoring, application: { name: applicationName ?? restoring.usedBy?.[0]?.name ?? "" } }}
        onClose={() => setRestoring(null)}
      />
    </Card>
  );
}
