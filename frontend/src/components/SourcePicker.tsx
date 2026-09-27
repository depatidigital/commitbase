import { useId, useMemo, useState, type ReactNode } from "react";
import { FileUp, FolderUp, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UploadTree } from "@/components/UploadTree";
import { entriesFromDrop, entriesFromInput, type UploadEntry } from "@/lib/applications";
import { locale, t } from "@/lib/i18n";
import { formatBytes } from "@/lib/utils";

type Props = {
  /** everything picked */
  picked: UploadEntry[];
  /** paths unticked in the preview */
  excluded: Set<string>;
  /** a new pick replaces the old one and clears the exclusions */
  onPick: (entries: UploadEntry[]) => void;
  onExcludedChange: (excluded: Set<string>) => void;
  /** another way in, under an "or" inside the drop zone — add-app's repository picker */
  alternative?: ReactNode;
};

/**
 * Drop zone plus file/folder buttons, then a tree of what was picked with
 * checkboxes for a partial upload. State stays with the caller, so moving
 * between wizard steps does not lose the pick. Used by the add-app wizard and
 * the re-upload dialog on an app's page.
 */
export function SourcePicker({ picked, excluded, onPick, onExcludedChange, alternative }: Props) {
  const [dragging, setDragging] = useState(false);
  // two pickers can sit on one page (wizard + dialog), so ids must not clash
  const id = useId();
  const selected = picked.filter(({ path }) => !excluded.has(path));
  // stable per pick, so the tree is not rebuilt on every checkbox click
  const treeItems = useMemo(() => picked.map(({ path, file }) => ({ path, size: file.size })), [picked]);
  // more files join the pick; the same path again replaces the earlier one
  const add = (entries: UploadEntry[]) => {
    const byPath = new Map(picked.map((entry) => [entry.path, entry]));
    for (const entry of entries) byPath.set(entry.path, entry);
    onPick([...byPath.values()]);
  };
  // dropping works on the empty zone and on the list alike
  const dropTarget = {
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      setDragging(true);
    },
    // moving over the buttons inside also fires dragleave
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
    },
    onDrop: async (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      add(await entriesFromDrop(e.dataTransfer.items));
    },
  };

  return (
    <div className="space-y-4">
      {/* the pickers, opened by the buttons in the zone and under the list */}
      <input
        id={`${id}-files`}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          add(entriesFromInput(e.target.files));
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
          add(entriesFromInput(e.target.files));
          e.target.value = "";
        }}
      />

      {/* one target for both: drop anything, or pick — a file input can open
          files or a folder, never both, hence two buttons. Gone once something
          is picked: the list takes its place until the pick is cancelled */}
      {picked.length === 0 && (
        <div
          {...dropTarget}
          className={`relative isolate flex flex-col items-center gap-3 overflow-hidden rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
            dragging ? "border-primary bg-primary/5" : "border-border/60"
          }`}
        >
          {/* a work-surface grid, fading out towards the edges */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(to_right,hsl(var(--border))_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--border))_1px,transparent_1px)] bg-[size:24px_24px] [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_75%)]"
          />
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
          {alternative && (
            <>
              <div className="flex w-full max-w-xs items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                {t("or")}
                <span className="h-px flex-1 bg-border" />
              </div>
              {alternative}
            </>
          )}
        </div>
      )}

      {picked.length > 0 && (
        // everything listed goes up: a row is removed, not unticked; more can be dropped on it
        <div {...dropTarget} className={`rounded-md transition-colors ${dragging ? "ring-2 ring-primary" : ""}`}>
          <UploadTree
            entries={treeItems}
            onRemove={(paths) => {
              const gone = new Set(paths);
              onPick(picked.filter(({ path }) => !gone.has(path)));
            }}
          />
        </div>
      )}

      {picked.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Pick the files or the folder to put online.")}</p>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {(() => {
              const vars = { count: selected.length, size: formatBytes(selected.reduce((sum, { file }) => sum + file.size, 0), locale) };
              return selected.length === 1 ? t("{count} file ready — {size}", vars) : t("{count} files ready — {size}", vars);
            })()}
          </p>
          <div className="flex flex-wrap items-center gap-1">
          <Button asChild type="button" variant="ghost" size="sm">
            <label htmlFor={`${id}-files`} className="cursor-pointer">
              <FileUp className="mr-2 h-4 w-4" />
              {t("Add files")}
            </label>
          </Button>
          <Button asChild type="button" variant="ghost" size="sm">
            <label htmlFor={`${id}-folder`} className="cursor-pointer">
              <FolderUp className="mr-2 h-4 w-4" />
              {t("Add folder")}
            </label>
          </Button>
          {/* back to the drop zone: a different pick, or the repository instead */}
          <Button type="button" variant="ghost" size="sm" onClick={() => onPick([])}>
            <X className="mr-2 h-4 w-4" />
            {t("Cancel")}
          </Button>
        </div>
      )}
    </div>
  );
}
