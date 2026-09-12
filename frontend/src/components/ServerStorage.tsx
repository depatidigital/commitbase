import { useState } from "react";
import { Link } from "react-router-dom";
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
import { cleanupServerDisk, getServerDisk } from "@/lib/servers";
import { locale, t } from "@/lib/i18n";
import { formatBytes } from "@/lib/utils";

/**
 * A node's disk: how full the filesystem tenant homes live on is, which apps
 * take the most, and one button that cleans up all of them. Measured when the
 * tab opens — one du per app over SSH — not polled.
 */
export function ServerStorage({ serverId }: { serverId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [withCache, setWithCache] = useState(false);
  const bytes = (value: number | null | undefined) => formatBytes(value, locale);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["servers", serverId, "disk"],
    queryFn: () => getServerDisk(serverId),
    staleTime: 60_000,
  });

  const cleanup = useMutation({
    mutationFn: () => cleanupServerDisk(serverId, withCache),
    onSuccess: (result) => {
      toast({
        title: t("Cleaned up"),
        description:
          t("{size} freed.", { size: bytes(result.freedBytes) }) +
          (result.skipped.length ? " " + t("Skipped while deploying: {apps}", { apps: result.skipped.join(", ") }) : ""),
      });
      void queryClient.invalidateQueries({ queryKey: ["servers", serverId, "disk"] });
      void queryClient.invalidateQueries({ queryKey: ["app-disk"] });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: t("Could not clean up"), description: e.message }),
  });

  const reclaimable = (data?.apps ?? []).reduce((sum, app) => sum + app.reclaimableBytes + (withCache ? app.cacheBytes : 0), 0);
  const usedPct = data?.disk ? Math.round((data.disk.used / data.disk.size) * 100) : 0;

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
                <Button variant="outline" size="sm" disabled={cleanup.isPending || data.apps.length === 0} onClick={() => setConfirming(true)}>
                  {cleanup.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                  {t("Clean up all")}
                </Button>
              </div>
            </div>

            {data.apps.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("No panel apps keep files on this node.")}</p>
            ) : (
              <div className="divide-y rounded-md border text-sm">
                {data.apps.map((app) => (
                  <div key={app.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <Link to={`/application/${app.id}`} className="min-w-0 truncate font-medium hover:underline">
                      {app.domain}
                    </Link>
                    <span className="flex items-center gap-3 text-xs text-muted-foreground">
                      {app.reclaimableBytes > 0 && (
                        <span className="text-destructive">{t("{size} unused", { size: bytes(app.reclaimableBytes) })}</span>
                      )}
                      <span>{t("cache {size}", { size: bytes(app.cacheBytes) })}</span>
                      <span className="w-20 text-right font-medium text-foreground">{bytes(app.totalBytes)}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}
      </CardContent>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Clean up every app on this node?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("Unused releases are deleted on each app. Live releases and the ones kept for rollback stay; apps that are deploying are skipped.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={withCache} onCheckedChange={(checked) => setWithCache(checked === true)} className="mt-0.5" />
            <span>
              <span className="font-medium">{t("Also delete the build caches")}</span>
              <span className="block text-xs text-muted-foreground">{t("Each app's next build is slower while it rebuilds its cache.")}</span>
            </span>
          </label>
          <p className="text-sm">{t("About {size} will be freed.", { size: bytes(reclaimable) })}</p>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => cleanup.mutate()} disabled={reclaimable === 0}>
              {t("Clean up all")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
