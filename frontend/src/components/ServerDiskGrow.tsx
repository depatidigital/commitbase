import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, HardDrive, Loader2, Maximize2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { getDiskLayout, growServerDisk } from "@/lib/servers";
import { locale, t } from "@/lib/i18n";
import { formatBytes } from "@/lib/utils";

/**
 * After the provider enlarges a server's disk, its partition and filesystem
 * still have the old size. This reads the three and grows the last two into
 * the disk — online, no reboot, no remount.
 */
export function ServerDiskGrow({ serverId }: { serverId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [snapshotted, setSnapshotted] = useState(false);
  const layout = useQuery({ queryKey: ["server", serverId, "disk-layout"], queryFn: () => getDiskLayout(serverId), retry: false });
  const grow = useMutation({
    mutationFn: () => growServerDisk(serverId),
    onSuccess: (after) => {
      queryClient.setQueryData(["server", serverId, "disk-layout"], after);
      // the disk figures elsewhere (server list, storage tab) read it again
      void queryClient.invalidateQueries({ queryKey: ["servers"] });
      void queryClient.invalidateQueries({ queryKey: ["server", serverId] });
      toast({ title: t("Disk grown"), description: t("{size} now, {free} free.", { size: formatBytes(after.filesystemBytes, locale), free: formatBytes(after.availBytes, locale) }) });
    },
    onError: (error: Error) => toast({ variant: "destructive", title: t("Could not grow the disk"), description: error.message }),
  });
  const d = layout.data;
  const line = (label: string, bytes: number, detail: string) => (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2 text-sm last:border-0">
      <span className="text-muted-foreground">
        {label} <span className="font-mono text-xs">{detail}</span>
      </span>
      <span className="font-medium">{formatBytes(bytes, locale)}</span>
    </div>
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="h-4 w-4 text-primary" />
            {t("Grow the disk")}
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("After the provider enlarged the disk: the partition and the filesystem are grown into it. Online — no reboot, no remount.")}
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => void layout.refetch()} disabled={layout.isFetching} title={t("Read again")} aria-label={t("Read again")}>
          <RefreshCw className={`h-4 w-4 ${layout.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {layout.isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : layout.error ? (
          <p className="text-sm text-destructive">{(layout.error as Error).message}</p>
        ) : d ? (
          <>
            <div>
              {line(t("Disk"), d.diskBytes, d.disk)}
              {line(d.lvm ? t("Partition (LVM)") : t("Partition"), d.partitionBytes, d.partition)}
              {line(t("Filesystem"), d.filesystemBytes, `${d.source} · ${d.fstype}`)}
            </div>
            {!d.supported ? (
              <p className="text-sm text-muted-foreground">{t("A {fs} filesystem cannot be grown here.", { fs: d.fstype || "?" })}</p>
            ) : d.growableBytes > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/40 bg-primary/5 p-3">
                <p className="text-sm">
                  {t("{size} of the disk is not used yet.", { size: formatBytes(d.growableBytes, locale) })}
                </p>
                <Button onClick={() => setConfirm(true)} disabled={grow.isPending}>
                  {grow.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Maximize2 className="mr-2 h-4 w-4" />}
                  {t("Grow to the whole disk")}
                </Button>
              </div>
            ) : (
              <p className="flex items-center gap-1.5 text-sm text-success">
                <CheckCircle2 className="h-4 w-4" />
                {t("The filesystem already uses the whole disk.")}
              </p>
            )}
          </>
        ) : null}
      </CardContent>

      <AlertDialog
        open={confirm}
        onOpenChange={(open) => {
          setConfirm(open);
          setSnapshotted(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Grow the root disk?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("The partition {partition} is extended to the end of {disk}, then the {fs} filesystem into it. It runs while the server keeps serving, and it cannot be shrunk back.", {
                partition: d?.partition ?? "",
                disk: d?.disk ?? "",
                fs: d?.fstype ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={snapshotted} onCheckedChange={(checked) => setSnapshotted(checked === true)} className="mt-0.5" />
            <span>{t("I have a snapshot or backup of this server at the provider.")}</span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <Button
              disabled={!snapshotted}
              onClick={() => {
                setConfirm(false);
                grow.mutate();
              }}
            >
              {t("Grow")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
