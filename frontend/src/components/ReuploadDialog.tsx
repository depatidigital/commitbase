import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SourcePicker } from "@/components/SourcePicker";
import { useToast } from "@/hooks/use-toast";
import {
  checkStaticUpload,
  getSiteFiles,
  startApplication,
  toUploadEntries,
  uploadApplicationSource,
  type Application,
  type UploadEntry,
} from "@/lib/applications";
import { t } from "@/lib/i18n";

/**
 * Replace the files of an app that was deployed from an upload. The only way
 * back after a failed upload short of deleting the app. A static site is live
 * once the upload lands; anything else is then rebuilt from the new files.
 */
export function ReuploadDialog({
  application,
  title = t("Upload files again"),
  seed,
  open,
  onOpenChange,
}: {
  application: Application;
  /** the label of the button that opened it */
  title?: string;
  /** files picked outside the dialog (a drop on the page) to start from */
  seed?: UploadEntry[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [picked, setPicked] = useState<UploadEntry[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  // on by default: a redeploy of a static site should look like the folder
  // uploaded, not the folder plus whatever earlier uploads left behind
  const [replace, setReplace] = useState(true);
  const isStatic = application.type === "STATIC";
  const selected = picked.filter(({ path }) => !excluded.has(path));

  const pick = (entries: UploadEntry[]) => {
    setPicked(entries);
    setExcluded(new Set());
  };
  useEffect(() => {
    if (!seed) return;
    setPicked(seed);
    setExcluded(new Set());
  }, [seed]);

  // what is on the site now, to say what this upload adds, overwrites and removes
  const { data: site } = useQuery({
    queryKey: ["site-files", application.id],
    queryFn: () => getSiteFiles(application.id),
    enabled: open && isStatic && !!application.staticBucket,
  });

  const check = isStatic && selected.length > 0 ? checkStaticUpload(selected) : null;
  // with no rollback, replacing the site with a pick that has no index.html
  // takes the site down — make that a deliberate choice, not a slip
  const blocked = !!check && !check.hasIndex && replace;

  const summary = (() => {
    if (!site || selected.length === 0) return null;
    const onSite = new Set(site.files.map((f) => f.key));
    const uploading = new Set(selected.map((e) => e.path));
    const added = selected.filter((e) => !onSite.has(e.path)).length;
    return {
      added,
      overwritten: selected.length - added,
      removed: replace ? site.files.filter((f) => !uploading.has(f.key)).length : 0,
    };
  })();

  const submit = async () => {
    setBusy(true);
    setProgress(0);
    try {
      await uploadApplicationSource(application.id, selected, {
        replace: isStatic && replace,
        onProgress: setProgress,
      });
      if (application.type !== "STATIC") await startApplication(application.id);
      toast({
        title: t("Files uploaded"),
        description:
          application.type === "STATIC"
            ? t("The site now serves the new files.")
            : t("Rebuilding from the new files…"),
      });
      setPicked([]);
      setExcluded(new Set());
      onOpenChange(false);
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Upload failed"),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
      // a failed upload is recorded too, so refresh either way
      queryClient.invalidateQueries({ queryKey: ["application", application.id] });
      queryClient.invalidateQueries({ queryKey: ["deployments", application.id] });
      queryClient.invalidateQueries({ queryKey: ["site-files", application.id] });
      queryClient.invalidateQueries({ queryKey: ["releases", application.id] });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {isStatic
              ? t("Upload the site's build output — the folder with index.html (usually dist/, build/ or out/).")
              : t("The app is rebuilt from the new files.")}
          </DialogDescription>
        </DialogHeader>

        <SourcePicker picked={picked} excluded={excluded} onPick={pick} onExcludedChange={setExcluded} />

        {check && (!check.hasIndex || check.looksLikeSource) && (
          <div className="flex gap-3 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div className="space-y-2">
              <p>
                {check.looksLikeSource
                  ? t("This looks like the project's source (package.json, src/), not its build output. Build it first and upload the output folder.")
                  : t("There is no index.html at the top level — visitors opening the site get a 404.")}
              </p>
              {check.buildDir && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => pick(toUploadEntries(picked.filter((e) => e.path.startsWith(`${check.buildDir}/`))))}
                >
                  {t("Upload only {dir}/", { dir: check.buildDir })}
                </Button>
              )}
              {blocked && (
                <p className="text-xs text-muted-foreground">
                  {t("To upload without an index.html anyway, turn off “Replace the whole site”.")}
                </p>
              )}
            </div>
          </div>
        )}

        {isStatic && (
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={replace}
              onCheckedChange={(checked) => setReplace(checked === true)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">{t("Replace the whole site")}</span>
              <span className="block text-xs text-muted-foreground">
                {replace
                  ? t("The new version has only these files. The current version is kept, so you can switch back to it.")
                  : t("Only adds and overwrites — the rest of the current version is carried over.")}
              </span>
            </span>
          </label>
        )}

        {summary && (
          <p className="text-sm">
            <span className="text-success">{t("{count} new", { count: summary.added })}</span>
            {" · "}
            {t("{count} overwritten", { count: summary.overwritten })}
            {" · "}
            <span className={summary.removed ? "text-destructive" : undefined}>
              {t("{count} removed", { count: summary.removed })}
            </span>
          </p>
        )}

        {busy && (
          <div className="space-y-1">
            <Progress value={progress * 100} className="h-2" />
            <p className="text-xs text-muted-foreground">
              {progress < 1
                ? t("Uploading… {percent}%", { percent: Math.floor(progress * 100) })
                : isStatic
                  ? t("Publishing to the site…")
                  : t("Saving the files…")}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button onClick={submit} disabled={busy || blocked || selected.length === 0}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
            {t("Upload")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
