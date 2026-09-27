import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, FolderOpen, Loader2, RefreshCw, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ReuploadDialog } from "@/components/ReuploadDialog";
import { UploadTree } from "@/components/UploadTree";
import { useApplication } from "@/hooks/useApplications";
import { getSiteFiles } from "@/lib/applications";
import { locale, t } from "@/lib/i18n";
import { formatBytes } from "@/lib/utils";

/**
 * What a static site is actually serving: the bucket's files as a tree, each
 * openable — read only. Changing them is an upload: "Upload files" opens the
 * same drop zone as creating the app. `bare`: no card of its own — a section
 * of the card it sits in.
 */
export function SiteFilesCard({ appId, bare = false }: { appId: string; bare?: boolean }) {
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);
  // the upload dialog needs the whole app; read once it is asked for
  const { data: application } = useApplication(uploading ? appId : "");

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["site-files", appId],
    queryFn: () => getSiteFiles(appId),
  });

  const items = useMemo(() => (data?.files ?? []).map((f) => ({ path: f.key, size: f.size })), [data]);
  const totalSize = items.reduce((sum, i) => sum + i.size, 0);

  return (
    <Card className={bare ? "rounded-none border-0 bg-transparent shadow-none" : "bg-gradient-card border-border/50"}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center space-x-2">
          <FolderOpen className="h-5 w-5 text-primary" />
          <span>{t("Site files")}</span>
          {data && (
            <span className="text-sm font-normal text-muted-foreground">
              {t("{count} files", { count: items.length })} · {formatBytes(totalSize, locale)}
            </span>
          )}
        </CardTitle>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching} aria-label={t("Refresh")}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setUploading(true)}>
            {uploading && !application ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
            {t("Upload files")}
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
            readOnly
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

      {application && (
        <ReuploadDialog
          application={application}
          title={t("Upload files")}
          open={uploading}
          onOpenChange={(open) => {
            setUploading(open);
            if (!open) void queryClient.invalidateQueries({ queryKey: ["site-files", appId] });
          }}
        />
      )}
    </Card>
  );
}
