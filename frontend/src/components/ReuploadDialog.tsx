import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  startApplication,
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
  open,
  onOpenChange,
}: {
  application: Application;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [picked, setPicked] = useState<UploadEntry[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // on by default: a redeploy of a static site should look like the folder
  // uploaded, not the folder plus whatever earlier uploads left behind
  const [replace, setReplace] = useState(true);
  const isStatic = application.type === "STATIC";
  const selected = picked.filter(({ path }) => !excluded.has(path));

  const submit = async () => {
    setBusy(true);
    try {
      await uploadApplicationSource(application.id, selected, { replace: isStatic && replace });
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
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("Upload files again")}</DialogTitle>
          <DialogDescription>
            {isStatic
              ? t("The uploaded files are published to the site.")
              : t("The app is rebuilt from the new files.")}
          </DialogDescription>
        </DialogHeader>

        <SourcePicker
          picked={picked}
          excluded={excluded}
          onPick={(entries) => {
            setPicked(entries);
            setExcluded(new Set());
          }}
          onExcludedChange={setExcluded}
        />

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
                  ? t("Files on the site that are not in this upload are deleted.")
                  : t("Only adds and overwrites — files already on the site stay.")}
              </span>
            </span>
          </label>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button onClick={submit} disabled={busy || selected.length === 0}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
            {t("Upload")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
