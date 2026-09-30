import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Play, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Column, DataTable, useTableQuery } from "@/components/DataTable";
import { useToast } from "@/hooks/use-toast";
import { getAppScripts, runAppScript } from "@/lib/applications";
import { locale, t } from "@/lib/i18n";

type Script = { name: string; command: string };

/**
 * A service's package.json scripts — seeds, backfills, repairs — as its live
 * release has them (read again on every open and refresh, so a deploy's new
 * script is there), each run on the server with the app's own environment.
 * One at a time, never during a deploy; the output is followed below.
 */
export function AppScripts({ appId, title }: { appId: string; title?: string }) {
  const { toast } = useToast();
  const query = useTableQuery(10);
  const [confirm, setConfirm] = useState<Script | null>(null);
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["app-scripts", appId],
    queryFn: () => getAppScripts(appId),
    // while one runs, its output is followed
    refetchInterval: (q) => (q.state.data?.run && !q.state.data.run.finishedAt ? 2000 : false),
  });
  const run = useMutation({
    mutationFn: (name: string) => runAppScript(appId, name),
    onSuccess: () => {
      setConfirm(null);
      void refetch();
    },
    onError: (e: Error) => toast({ variant: "destructive", title: t("Could not run the script"), description: e.message }),
  });

  const running = !!data?.run && !data.run.finishedAt;
  const rows: Script[] = Object.entries(data?.scripts ?? {}).map(([name, command]) => ({ name, command }));
  // the output stays at its end while it grows
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [data?.log]);

  const columns: Column<Script>[] = [
    { header: t("Script"), className: "w-[30%]", cell: (s) => <span className="block truncate font-mono text-xs font-medium">{s.name}</span> },
    { header: t("Command"), cell: (s) => <span className="block truncate font-mono text-xs text-muted-foreground" title={s.command}>{s.command}</span> },
    {
      header: <span className="sr-only">{t("Actions")}</span>,
      className: "w-28 text-right",
      cell: (s) => (
        <Button size="sm" variant="outline" disabled={running || data?.busy || run.isPending} onClick={() => setConfirm(s)}>
          {running && data?.run?.name === s.name ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-2 h-3.5 w-3.5" />}
          {t("Run")}
        </Button>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title ?? t("Scripts")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <p className="text-sm text-muted-foreground">{(error as Error).message}</p>
        ) : (
          <>
            {data?.busy && !running && <p className="text-sm text-warning">{t("A deployment is running for this service: scripts wait until it is done.")}</p>}
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(s) => s.name}
              query={query}
              filter={(s, search) => `${s.name} ${s.command}`.toLowerCase().includes(search.toLowerCase())}
              isLoading={isFetching && !data}
              searchPlaceholder={t("Search scripts…")}
              empty={t("The live release's package.json has no scripts.")}
              toolbar={
                <Button size="sm" variant="outline" onClick={() => void refetch()} disabled={isFetching}>
                  <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} /> {t("Refresh")}
                </Button>
              }
            />
            {data?.run && (
              <div className="space-y-2">
                <p className="flex items-center gap-2 text-sm">
                  {running ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : data.run.ok ? (
                    <CheckCircle2 className="h-4 w-4 text-success" />
                  ) : (
                    <XCircle className="h-4 w-4 text-destructive" />
                  )}
                  <span className="font-mono text-xs font-medium">{data.run.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {running
                      ? t("running since {time}", { time: new Date(data.run.startedAt).toLocaleTimeString(locale) })
                      : t("{outcome} at {time}", { outcome: data.run.ok ? t("finished") : t("failed"), time: new Date(data.run.finishedAt!).toLocaleString(locale) })}
                  </span>
                </p>
              </div>
            )}
            {data?.log && (
              <pre ref={logRef} className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs">
                {data.log}
              </pre>
            )}
          </>
        )}
      </CardContent>

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Run {name}?", { name: confirm?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("It runs on the server against the live release, with the service's environment — its real database. It cannot be stopped from here once started.")}
              <code className="mt-2 block break-all rounded-md bg-muted p-2 font-mono text-xs text-foreground">{confirm?.command}</code>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={run.isPending}
              onClick={(e) => {
                // stays open until the server took it
                e.preventDefault();
                if (confirm) run.mutate(confirm.name);
              }}
            >
              {run.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("Run")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
