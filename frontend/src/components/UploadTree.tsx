import { useMemo, useState } from "react";
import { ChevronRight, File as FileIcon, Folder } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import type { UploadEntry } from "@/lib/applications";
import { t } from "@/lib/i18n";

type Node = {
  name: string;
  path: string;
  /** set on files only */
  entry?: UploadEntry;
  children: Map<string, Node>;
  /** every file path at or below this node — what its checkbox toggles */
  files: string[];
  size: number;
};

const newNode = (name: string, path: string): Node => ({
  name,
  path,
  children: new Map(),
  files: [],
  size: 0,
});

const buildTree = (entries: UploadEntry[]): Node => {
  const root = newNode("", "");
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let node = root;
    node.files.push(entry.path);
    node.size += entry.file.size;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      let child = node.children.get(part);
      if (!child) {
        child = newNode(part, path);
        node.children.set(part, child);
      }
      child.files.push(entry.path);
      child.size += entry.file.size;
      if (i === parts.length - 1) child.entry = entry;
      node = child;
    });
  }
  return root;
};

/** folders first, then files, each alphabetical */
const sorted = (node: Node) =>
  [...node.children.values()].sort(
    (a, b) => Number(!!a.entry) - Number(!!b.entry) || a.name.localeCompare(b.name),
  );

const formatSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

type Props = {
  entries: UploadEntry[];
  /** paths left out of the upload */
  excluded: Set<string>;
  onExcludedChange: (excluded: Set<string>) => void;
};

/**
 * The picked files as a tree, each file and folder with a checkbox, so part of
 * a selection can be left out. Folders render their children only once opened
 * — a picked project can hold thousands of files.
 */
export function UploadTree({ entries, excluded, onExcludedChange }: Props) {
  const tree = useMemo(() => buildTree(entries), [entries]);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const toggle = (node: Node, include: boolean) => {
    const next = new Set(excluded);
    for (const path of node.files) {
      if (include) next.delete(path);
      else next.add(path);
    }
    onExcludedChange(next);
  };

  const render = (node: Node, depth: number) => {
    const left = node.files.filter((path) => excluded.has(path)).length;
    const state = left === 0 ? true : left === node.files.length ? false : "indeterminate";
    const isOpen = open.has(node.path);
    const folder = !node.entry;

    return (
      <div key={node.path}>
        <div
          className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/50"
          style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}
        >
          {folder ? (
            <button
              type="button"
              aria-label={isOpen ? t("Collapse") : t("Expand")}
              aria-expanded={isOpen}
              onClick={() => {
                const next = new Set(open);
                if (isOpen) next.delete(node.path);
                else next.add(node.path);
                setOpen(next);
              }}
              className="text-muted-foreground"
            >
              <ChevronRight
                className={`h-4 w-4 transition-transform ${isOpen ? "rotate-90" : ""}`}
              />
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <Checkbox
            checked={state}
            onCheckedChange={() => toggle(node, state !== true)}
            aria-label={node.path}
          />
          {folder ? (
            <Folder className="h-4 w-4 shrink-0 text-primary" />
          ) : (
            <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className={`flex-1 truncate ${state === false ? "text-muted-foreground line-through" : ""}`}>
            {node.name}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {folder
              ? `${t("{count} files", { count: node.files.length })} · ${formatSize(node.size)}`
              : formatSize(node.size)}
          </span>
        </div>
        {folder && isOpen && sorted(node).map((child) => render(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="max-h-80 overflow-auto rounded-md border border-border/60 py-1">
      {sorted(tree).map((child) => render(child, 0))}
    </div>
  );
}
