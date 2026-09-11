import { useId, useMemo, useState } from "react";
import { FileUp, FolderUp, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UploadTree } from "@/components/UploadTree";
import { entriesFromDrop, entriesFromInput, type UploadEntry } from "@/lib/applications";
import { t } from "@/lib/i18n";

type Props = {
  /** everything picked */
  picked: UploadEntry[];
  /** paths unticked in the preview */
  excluded: Set<string>;
  /** a new pick replaces the old one and clears the exclusions */
  onPick: (entries: UploadEntry[]) => void;
  onExcludedChange: (excluded: Set<string>) => void;
};

/**
 * Drop zone plus file/folder buttons, then a tree of what was picked with
 * checkboxes for a partial upload. State stays with the caller, so moving
 * between wizard steps does not lose the pick. Used by the add-app wizard and
 * the re-upload dialog on an app's page.
 */
export function SourcePicker({ picked, excluded, onPick, onExcludedChange }: Props) {
  const [dragging, setDragging] = useState(false);
  // two pickers can sit on one page (wizard + dialog), so ids must not clash
  const id = useId();
  const selected = picked.filter(({ path }) => !excluded.has(path));
  // stable per pick, so the tree is not rebuilt on every checkbox click
  const treeItems = useMemo(() => picked.map(({ path, file }) => ({ path, size: file.size })), [picked]);

  return (
    <div className="space-y-4">
      {/* one target for both: drop anything, or pick — a file input can open
          files or a folder, never both, hence two buttons */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        // moving over the buttons inside also fires dragleave
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={async (e) => {
          e.preventDefault();
          setDragging(false);
          onPick(await entriesFromDrop(e.dataTransfer.items));
        }}
        className={`flex flex-col items-center gap-3 rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
          dragging ? "border-primary bg-primary/5" : "border-border/60"
        }`}
      >
        <Upload className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium">{t("Drop files or a folder here")}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild type="button" variant="outline" size="sm">
            <label htmlFor={`${id}-files`} className="cursor-pointer">
              <FileUp className="mr-2 h-4 w-4" />
              {t("Choose files")}
            </label>
          </Button>
          <Button asChild type="button" variant="outline" size="sm">
            <label htmlFor={`${id}-folder`} className="cursor-pointer">
              <FolderUp className="mr-2 h-4 w-4" />
              {t("Choose folder")}
            </label>
          </Button>
        </div>
        <input
          id={`${id}-files`}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            onPick(entriesFromInput(e.target.files));
            // picking the same thing again must fire onChange again
            e.target.value = "";
          }}
        />
        <input
          id={`${id}-folder`}
          type="file"
          multiple
          hidden
          // folder picking is a non-standard attribute, hence the spread
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(e) => {
            onPick(entriesFromInput(e.target.files));
            e.target.value = "";
          }}
        />
      </div>

      {picked.length > 0 && (
        <UploadTree entries={treeItems} excluded={excluded} onExcludedChange={onExcludedChange} />
      )}

      <p className="text-sm text-muted-foreground">
        {picked.length === 0
          ? t("Pick the files or the folder to deploy.")
          : (() => {
              const vars = {
                count: selected.length,
                size: (selected.reduce((sum, { file }) => sum + file.size, 0) / (1024 * 1024)).toFixed(1),
              };
              return selected.length === 1
                ? t("{count} file ready — {size} MB", vars)
                : t("{count} files ready — {size} MB", vars);
            })()}
      </p>
    </div>
  );
}
