import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, FileUp, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getDatabaseImports, getDatabaseTables, importDatabase, sniffDump } from "@/lib/databases";
import { locale, t } from "@/lib/i18n";

/** Just what the dialog shows about its target — both the Databases page's rows and an app's list fit. */
export interface ImportTarget {
  id: string;
  name: string;
  dbName?: string | null;
  type: string;
  databaseServer?: { name: string } | null;
  organization?: { name: string } | null;
  application?: { name: string } | null;
}

const ENGINE_LABEL: Record<string, string> = { POSTGRESQL: "PostgreSQL", MYSQL: "MySQL" };

const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024)).toLocaleString(locale)} KB`
    : `${(bytes / 1024 / 1024).toLocaleString(locale, { maximumFractionDigits: 1 })} MB`;

/**
 * Restore a .sql / .sql.gz into one database. It runs on top of what is
 * there: tables are only replaced when the dump drops them first, as the
 * suggested export flags do. The target is fixed by whoever opens it — the
 * dialog never lets you pick another — and spelled out in full
 * (real name, engine, server, owner), with its table count: into a database
 * that already has tables, the name is typed to confirm. After the upload the
 * run is followed live; closing the dialog does not stop it.
 */
export function DatabaseImportDialog({ database, onClose }: { database: ImportTarget | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const open = !!database;
  const dbName = database?.dbName ?? database?.name ?? "";
  const engine = database?.type ?? "";

  const [file, setFile] = useState<File | null>(null);
  const [sniff, setSniff] = useState<Awaited<ReturnType<typeof sniffDump>> | null>(null);
  const [confirm, setConfirm] = useState("");
  const [progress, setProgress] = useState(0);
  // the run this dialog started: its result stays up after it finishes
  const [startedId, setStartedId] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setFile(null);
    setSniff(null);
    setConfirm("");
    setProgress(0);
    setStartedId(null);
  }, [open]);

  const { data: tables, error: tablesError, isFetching: tablesLoading } = useQuery({
    queryKey: ["databases", database?.id, "tables"],
    queryFn: () => getDatabaseTables(database!.id),
    enabled: open,
    staleTime: 0,
    retry: false,
  });

  const { data: imports } = useQuery({
    queryKey: ["databases", database?.id, "imports"],
    queryFn: () => getDatabaseImports(database!.id),
    enabled: open,
    refetchInterval: (query) => (query.state.data?.[0]?.status === "RUNNING" ? 2000 : false),
  });
  const latest = imports?.[0];
  const current = latest && (latest.status === "RUNNING" || latest.id === startedId) ? latest : null;

  // a finished run changes what's in the database
  useEffect(() => {
    if (current && current.status !== "RUNNING") queryClient.invalidateQueries({ queryKey: ["databases"] });
  }, [current?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async (picked: File | null) => {
    setFile(picked);
    setSniff(picked ? await sniffDump(picked) : null);
  };

  const start = useMutation({
    mutationFn: () => importDatabase(database!.id, file!, { confirm: tables ? confirm : undefined, onProgress: setProgress }),
    onSuccess: (row) => {
      setStartedId(row.id);
      queryClient.invalidateQueries({ queryKey: ["databases", database?.id, "imports"] });
    },
    onSettled: () => setProgress(0),
  });

  const wrongEngine = !!sniff?.engine && sniff.engine !== engine;
  const otherDatabase =
    sniff?.otherDatabase && (engine === "POSTGRESQL" || sniff.otherDatabase !== dbName) ? sniff.otherDatabase : null;
  const needsConfirm = (tables ?? 0) > 0;
  const ready =
    !!file && tables !== undefined && !wrongEngine && !otherDatabase && (!needsConfirm || confirm === dbName) && !start.isPending;

  const targetRows: Array<[string, string | null | undefined]> = [
    [t("Database"), dbName],
    [t("Engine"), ENGINE_LABEL[engine] ?? engine],
    [t("Organization"), database?.organization?.name],
    [t("App"), database?.application?.name],
  ];

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("Restore {name} from a .sql file", { name: dbName })}</DialogTitle>
          <DialogDescription>{t("Only this database is changed.")}</DialogDescription>
        </DialogHeader>

        {/* the target, spelled out: this is where "is it the right one?" gets answered */}
        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          {targetRows
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-4 py-0.5">
                <span className="text-muted-foreground">{label}</span>
                <span className={label === t("Database") ? "truncate font-mono font-medium" : "truncate"}>{value}</span>
              </div>
            ))}
          <div className="flex items-center justify-between gap-4 py-0.5">
            <span className="text-muted-foreground">{t("Tables now")}</span>
            {tablesLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : tablesError ? (
              <span className="truncate text-destructive" title={(tablesError as Error).message}>
                {(tablesError as Error).message}
              </span>
            ) : (
              <span>{tables ? t("{count} tables", { count: tables }) : t("Empty")}</span>
            )}
          </div>
        </div>

        {current ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              {current.status === "RUNNING" ? (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              ) : current.status === "DONE" ? (
                <CheckCircle2 className="h-4 w-4 text-success" />
              ) : (
                <XCircle className="h-4 w-4 text-destructive" />
              )}
              <span className="font-medium">
                {current.status === "RUNNING"
                  ? t("Restoring {file}…", { file: current.fileName })
                  : current.status === "DONE"
                    ? t("Restored {file}", { file: current.fileName })
                    : t("Restore of {file} failed", { file: current.fileName })}
              </span>
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">
              {current.log || t("Starting…")}
            </pre>
            {current.status === "RUNNING" && (
              <p className="text-xs text-muted-foreground">{t("You can close this dialog — the restore keeps running.")}</p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="import-file">{t("SQL file")}</Label>
              <Input
                id="import-file"
                type="file"
                accept=".sql,.gz,application/sql,application/gzip"
                onChange={(e) => pick(e.target.files?.[0] ?? null)}
              />
              {!file && <p className="text-xs text-muted-foreground">{t("A backup downloaded here, or another .sql file.")}</p>}
              {file && (
                <p className="text-xs text-muted-foreground">
                  {size(file.size)}
                  {sniff?.engine && !wrongEngine && ` · ${t("{engine} dump", { engine: ENGINE_LABEL[sniff.engine] })}`}
                </p>
              )}
              {wrongEngine && (
                <p className="flex items-start gap-1.5 text-xs text-destructive">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {t("This is a {found} dump, but {name} is {engine}.", {
                    found: ENGINE_LABEL[sniff!.engine!],
                    name: dbName,
                    engine: ENGINE_LABEL[engine] ?? engine,
                  })}
                </p>
              )}
              {otherDatabase && (
                <p className="flex items-start gap-1.5 text-xs text-destructive">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {t("The file switches to database {other} — it would be refused. Export only the one database, without {flag}.", {
                    other: otherDatabase,
                    flag: engine === "MYSQL" ? "--databases" : "-C/--create",
                  })}
                </p>
              )}
            </div>

            <div className="space-y-1 text-xs text-muted-foreground">
              <p>
                {engine === "MYSQL"
                  ? t("MySQL can't undo table changes: if a statement fails, what ran before it stays. Back up first, or restore into an empty database.")
                  : t("Runs in one transaction: if any statement fails, nothing is kept.")}
              </p>
            </div>

            {needsConfirm && (
              <div className="space-y-2">
                <Label htmlFor="import-confirm">
                  {t("{name} already has {count} tables. Type its name to restore into it anyway.", { name: dbName, count: tables! })}
                </Label>
                <Input id="import-confirm" autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </div>
            )}

            {start.isPending && (
              <div className="space-y-1">
                <Progress value={progress * 100} />
                <p className="text-xs text-muted-foreground">
                  {progress < 1 ? t("Uploading… {percent}%", { percent: Math.round(progress * 100) }) : t("Starting…")}
                </p>
              </div>
            )}
            {start.error && <p className="text-sm text-destructive">{(start.error as Error).message}</p>}
          </div>
        )}

        <DialogFooter>
          {current && current.status !== "RUNNING" ? (
            <Button
              variant="outline"
              onClick={() => {
                setStartedId(null);
                setFile(null);
                setSniff(null);
                setConfirm("");
                start.reset();
              }}
            >
              <FileUp className="mr-2 h-4 w-4" />
              {t("Restore another file")}
            </Button>
          ) : !current ? (
            <Button disabled={!ready} onClick={() => start.mutate()}>
              {start.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileUp className="mr-2 h-4 w-4" />}
              {t("Restore")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
