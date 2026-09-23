import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
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
import { useToast } from "@/hooks/use-toast";
import { getSystemCleanup, runSystemCleanup, SYSTEM_TARGETS, type SystemTarget } from "@/lib/servers";
import { locale, t } from "@/lib/i18n";
import { formatBytes } from "@/lib/utils";

const LABELS: Record<SystemTarget, { title: string; path: string; note: string }> = {
  journal: { title: "Systemd journal", path: "/var/log/journal", note: "Entries older than 7 days are removed." },
  rotatedLogs: { title: "Rotated logs", path: "/var/log/*.gz, *.1, *.old", note: "Old log files logrotate left behind." },
  pm2Logs: { title: "PM2 logs", path: "~/.pm2/logs/*.log", note: "Emptied, not deleted — PM2 keeps them open." },
  aptCache: { title: "APT package cache", path: "/var/cache/apt/archives", note: "Downloaded .deb files, fetched again when needed." },
  packageCaches: { title: "npm / Yarn caches", path: "~/.npm/_cacache, ~/.cache/yarn", note: "The next install downloads again." },
  docker: { title: "Docker leftovers", path: "dangling images, build cache", note: "Containers and tagged images are kept." },
  crashDumps: { title: "Crash dumps", path: "/var/crash, /var/lib/systemd/coredump", note: "" },
  oldTmp: { title: "Old temp files", path: "/tmp, /var/tmp", note: "Files untouched for 7 days." },
};

/** Clutter outside the app trees: logs, caches, dumps. Measured when the tab opens, not polled. */
export function ServerSystemCleanup({ serverId }: { serverId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<Set<SystemTarget>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const bytes = (value: number | null | undefined) => formatBytes(value, locale);
  const queryKey = ["servers", serverId, "system-cleanup"];

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey,
    queryFn: () => getSystemCleanup(serverId),
    staleTime: 60_000,
  });

  const cleanup = useMutation({
    mutationFn: () => runSystemCleanup(serverId, [...picked]),
    onSuccess: (result) => {
      toast({
        title: t("Cleaned up"),
        description:
          t("{size} freed.", { size: bytes(result.freedBytes) }) +
          (result.failed.length ? " " + t("Failed: {targets}", { targets: result.failed.map((id) => t(LABELS[id as SystemTarget]?.title ?? id)).join(", ") }) : ""),
      });
      setPicked(new Set());
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: ["servers", serverId, "disk"] });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: t("Could not clean up"), description: e.message }),
  });

  const present = SYSTEM_TARGETS.filter((id) => data?.targets[id] !== undefined);
  const selected = present.reduce((sum, id) => sum + (picked.has(id) ? data!.targets[id]! : 0), 0);
  const usedPct = data?.disk ? Math.round((data.disk.used / data.disk.size) * 100) : 0;
  const toggle = (id: SystemTarget, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        {isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("Measuring…")}
          </p>
        ) : error ? (
          <p className="text-sm text-destructive">{(error as Error).message}</p>
        ) : data ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                {data.disk ? (
                  <>
                    <div className="flex justify-between text-sm">
                      <span>{t("{used} of {size} used", { used: bytes(data.disk.used), size: bytes(data.disk.size) })}</span>
                      <span className={usedPct >= 90 ? "font-medium text-destructive" : "text-muted-foreground"}>
                        {t("{free} free", { free: bytes(data.disk.avail) })}
                      </span>
                    </div>
                    <Progress value={usedPct} className={`h-2 ${usedPct >= 90 ? "[&>div]:bg-destructive" : ""}`} />
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("The node did not report its disk.")}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching} aria-label={t("Refresh")}>
                  <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
                </Button>
                <Button variant="outline" size="sm" disabled={cleanup.isPending || picked.size === 0} onClick={() => setConfirming(true)}>
                  {cleanup.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                  {t("Clean up selected")}
                </Button>
              </div>
            </div>

            <div className="divide-y rounded-md border text-sm">
              {present.map((id) => (
                <label key={id} className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-muted/40">
                  <Checkbox
                    checked={picked.has(id)}
                    onCheckedChange={(checked) => toggle(id, checked === true)}
                    disabled={data.targets[id] === 0}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{t(LABELS[id].title)}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">{LABELS[id].path}</span>
                    {LABELS[id].note && <span className="block text-xs text-muted-foreground">{t(LABELS[id].note)}</span>}
                  </span>
                  <span className="w-20 text-right font-medium">{bytes(data.targets[id])}</span>
                </label>
              ))}
            </div>
          </>
        ) : null}
      </CardContent>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Clean up the selected items?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {[...picked].map((id) => t(LABELS[id].title)).join(", ")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="text-sm">{t("Up to {size} will be freed.", { size: bytes(selected) })}</p>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => cleanup.mutate()}>{t("Clean up")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
