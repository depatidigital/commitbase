import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, FolderOpen, Loader2, RefreshCw, Trash2 } from "lucide-react";
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
import { UploadTree } from "@/components/UploadTree";
import { useToast } from "@/hooks/use-toast";
import { deleteSiteFiles, getSiteFiles } from "@/lib/applications";
import { t } from "@/lib/i18n";

/**
 * What a static site is actually serving: the bucket's files as a tree, each
 * openable, and ticked ones deletable. Deliberately not a file manager — a
 * site is redeployed whole (Upload files again); this is for checking the
 * result and pulling the odd wrong file.
 */
export function SiteFilesCard({ appId }: { appId: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // the tree tracks unticked paths; here nothing starts ticked
  const [unticked, setUnticked] = useState<Set<string> | null>(null);
  const [confirming, setConfirming] = useState(false);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["site-files", appId],
    queryFn: () => getSiteFiles(appId),
  });

  const items = useMemo(() => (data?.files ?? []).map((f) => ({ path: f.key, size: f.size })), [data]);
  const allPaths = useMemo(() => new Set(items.map((i) => i.path)), [items]);
  const excluded = unticked ?? allPaths;
  const selected = items.filter((i) => !excluded.has(i.path)).map((i) => i.path);
  const totalSize = items.reduce((sum, i) => sum + i.size, 0);

  const remove = useMutation({
    mutationFn: (keys: string[]) => deleteSiteFiles(appId, keys),
    onSuccess: (deleted) => {
      toast({ title: t("Files deleted"), description: t("{count} files removed from the site.", { count: deleted }) });
      setUnticked(null);
    },
    onError: (e: Error) => toast({ variant: "destructive", title: t("Error"), description: e.message }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["site-files", appId] }),
  });

  return (
    <Card className="bg-gradient-card border-border/50">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center space-x-2">
          <FolderOpen className="h-5 w-5 text-primary" />
          <span>{t("Site files")}</span>
          {data && (
            <span className="text-sm font-normal text-muted-foreground">
              {t("{count} files", { count: items.length })} · {(totalSize / (1024 * 1024)).toFixed(1)} MB
            </span>
          )}
        </CardTitle>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching} aria-label={t("Refresh")}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={selected.length === 0 || remove.isPending}
            onClick={() => setConfirming(true)}
          >
            {remove.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
            {t("Delete ({count})", { count: selected.length })}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("Loading files…")}
          </p>
        ) : error ? (
          <p className="text-sm text-destructive">{(error as Error).message}</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("The site has no files.")}</p>
        ) : (
          <UploadTree
            entries={items}
            excluded={excluded}
            onExcludedChange={setUnticked}
            strikeUnchecked={false}
            fileAction={(path) =>
              data?.origin ? (
                <a
                  href={`https://${data.origin}/${path.split("/").map(encodeURIComponent).join("/")}`}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 text-muted-foreground hover:text-primary"
                  aria-label={t("Open {path}", { path })}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              ) : null
            }
          />
        )}
      </CardContent>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Delete {count} files from the site?", { count: selected.length })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("They stop being served right away. Earlier releases keep their copies — switch back to one in Deployments to bring them back.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => remove.mutate(selected)}
            >
              {t("Delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
