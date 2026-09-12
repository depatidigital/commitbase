import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { cleanupAppDisk, getAppDisk, type ReleaseState } from "@/lib/applications";
import { locale, t } from "@/lib/i18n";
import { formatBytes } from "@/lib/utils";

const STATE_LABEL: Record<ReleaseState, string> = {
  live: t("Serving"),
  rollback: t("For rollback"),
  unused: t("Not used"),
};

/**
 * What the app takes on its node — releases, build cache, logs — and a button
 * that gives back the unused part. Measured on open (a du over SSH), not polled.
 */
export function AppStorageCard({ appId, deploying }: { appId: string; deploying: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [withCache, setWithCache] = useState(false);
  const bytes = (value: number) => formatBytes(value, locale);

  const { data: disk, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["app-disk", appId],
    queryFn: () => getAppDisk(appId),
    staleTime: 60_000,
  });

  const cleanup = useMutation({
    mutationFn: () => cleanupAppDisk(appId, withCache),
    onSuccess: (result) => {
      toast({ title: t("Cleaned up"), description: t("{size} freed.", { size: bytes(result.freedBytes) }) });
      void queryClient.invalidateQueries({ queryKey: ["app-disk", appId] });
      // rollback entries whose trees went are gone too
      void queryClient.invalidateQueries({ queryKey: ["releases", appId] });
    },
    onError: (e: Error) => toast({ variant: "destructive", title: t("Could not clean up"), description: e.message }),
  });

  // a static site keeps nothing on a node
  if (!isLoading && !error && !disk) return null;
  const freeable = (disk?.reclaimableBytes ?? 0) + (withCache ? disk?.cacheBytes ?? 0 : 0);

  return (
    <Card className="bg-gradient-card border-border/50">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2">
          <HardDrive className="h-5 w-5 text-primary" />
          <span>{t("Storage")}</span>
          {disk && <span className="text-sm font-normal text-muted-foreground">{bytes(disk.totalBytes)}</span>}
        </CardTitle>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching} aria-label={t("Refresh")}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!disk || deploying || cleanup.isPending}
            title={deploying ? t("A deployment is running — clean up once it has finished") : undefined}
            onClick={() => setConfirming(true)}
          >
            {cleanup.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
            {t("Clean up")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {isLoading ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("Measuring…")}
          </p>
        ) : error ? (
          <p className="text-destructive">{(error as Error).message}</p>
        ) : disk ? (
          <>
            <div className="divide-y rounded-md border">
              {disk.releases.length === 0 && (
                <p className="px-3 py-2 text-muted-foreground">{t("No releases on the server.")}</p>
              )}
              {disk.releases.map((release) => (
                <div key={release.name} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-xs">{release.name}</span>
                    <Badge
                      variant={release.state === "live" ? "default" : release.state === "rollback" ? "secondary" : "outline"}
                      className="text-xs"
                    >
                      {STATE_LABEL[release.state]}
                    </Badge>
                  </span>
                  <span className={release.state === "unused" ? "text-destructive" : "text-muted-foreground"}>
                    {bytes(release.bytes)}
                  </span>
                </div>
              ))}
              <div className="flex justify-between px-3 py-2 text-muted-foreground">
                <span>{t("Build cache (Next.js)")}</span>
                <span>{bytes(disk.cacheBytes)}</span>
              </div>
              <div className="flex justify-between px-3 py-2 text-muted-foreground">
                <span>{t("Source checkout")}</span>
                <span>{bytes(disk.sourcesBytes)}</span>
              </div>
              <div className="flex justify-between px-3 py-2 text-muted-foreground">
                <span>{t("Logs")}</span>
                <span>{bytes(disk.logsBytes)}</span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("Files shared between releases (node_modules while the lockfile is unchanged) are counted once, on the live release.")}{" "}
              {disk.reclaimableBytes > 0
                ? t("{size} can be freed now.", { size: bytes(disk.reclaimableBytes) })
                : t("Nothing unused right now.")}
            </p>
          </>
        ) : null}
      </CardContent>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Clean up this app's storage?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("Releases marked Not used are deleted. The live release and the ones kept for rollback stay.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={withCache} onCheckedChange={(checked) => setWithCache(checked === true)} className="mt-0.5" />
            <span>
              <span className="font-medium">{t("Also delete the build cache")}</span>
              <span className="block text-xs text-muted-foreground">
                {t("{size} more — the next build is slower while it rebuilds the cache.", { size: bytes(disk?.cacheBytes ?? 0) })}
              </span>
            </span>
          </label>
          <p className="text-sm">{t("About {size} will be freed.", { size: bytes(freeable) })}</p>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => cleanup.mutate()} disabled={freeable === 0}>
              {t("Clean up")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
