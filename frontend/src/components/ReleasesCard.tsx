import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { useToast } from "@/hooks/use-toast";
import { activateRelease, getReleases, type Release } from "@/lib/applications";
import { locale, t } from "@/lib/i18n";

/**
 * Built releases kept on the server (the last few), with a switch to any READY
 * one — a rollback that does not rebuild. Hidden when there are none, e.g. a
 * static site, which is served from its bucket rather than a release.
 */
export function ReleasesCard({ appId }: { appId: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirm, setConfirm] = useState<Release | null>(null);

  const { data } = useQuery({
    queryKey: ["releases", appId],
    queryFn: () => getReleases(appId),
  });

  const activate = useMutation({
    mutationFn: (release: Release) => activateRelease(appId, release.id),
    onSuccess: () => toast({ title: t("Switched release"), description: t("The selected release is now serving.") }),
    onError: (error: Error) => toast({ variant: "destructive", title: t("Error"), description: error.message }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["releases", appId] });
      queryClient.invalidateQueries({ queryKey: ["application", appId] });
    },
  });

  if (!data || data.releases.length === 0) return null;

  return (
    <Card className="bg-gradient-card border-border/50">
      <CardHeader>
        <CardTitle className="flex items-center space-x-2">
          <History className="h-5 w-5 text-primary" />
          <span>{t("Releases")}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {data.releases.map((release) => {
          const active = release.id === data.activeReleaseId;
          return (
            <div key={release.id} className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono">{release.commitSha?.slice(0, 7) || "—"}</span>
                  {active ? (
                    <Badge>{t("Serving")}</Badge>
                  ) : release.status !== "READY" ? (
                    <Badge variant="outline">{release.status}</Badge>
                  ) : null}
                </div>
                <div className="text-xs text-muted-foreground">
                  {new Date(release.createdAt).toLocaleString(locale)}
                </div>
              </div>
              {!active && release.status === "READY" && (
                <Button variant="outline" size="sm" disabled={activate.isPending} onClick={() => setConfirm(release)}>
                  {activate.isPending && activate.variables?.id === release.id && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  {t("Roll back to this")}
                </Button>
              )}
            </div>
          );
        })}
      </CardContent>

      <AlertDialog open={!!confirm} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Roll back to this release?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("The app stops briefly and restarts on the selected build. Nothing is rebuilt.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirm) activate.mutate(confirm);
                setConfirm(null);
              }}
            >
              {t("Roll back")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
