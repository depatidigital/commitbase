import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FileVideo,
  type LucideIcon,
} from "lucide-react";

type Kind = { icon: LucideIcon; color: string };

const KINDS: Record<string, Kind> = {
  web: { icon: FileCode, color: "text-orange-500" },
  style: { icon: FileCode, color: "text-sky-500" },
  script: { icon: FileCode, color: "text-yellow-500" },
  code: { icon: FileCode, color: "text-emerald-500" },
  data: { icon: FileJson, color: "text-amber-500" },
  config: { icon: FileCog, color: "text-slate-500" },
  image: { icon: FileImage, color: "text-violet-500" },
  video: { icon: FileVideo, color: "text-pink-500" },
  audio: { icon: FileAudio, color: "text-pink-500" },
  archive: { icon: FileArchive, color: "text-amber-700" },
  text: { icon: FileText, color: "text-muted-foreground" },
  sheet: { icon: FileSpreadsheet, color: "text-green-600" },
  font: { icon: FileType, color: "text-rose-500" },
  shell: { icon: FileTerminal, color: "text-slate-500" },
  lock: { icon: FileLock, color: "text-muted-foreground" },
};

const BY_EXTENSION: Record<string, keyof typeof KINDS> = {};
const add = (kind: keyof typeof KINDS, extensions: string) => {
  for (const ext of extensions.split(" ")) BY_EXTENSION[ext] = kind;
};
add("web", "html htm xhtml");
add("style", "css scss sass less");
add("script", "js mjs cjs jsx ts tsx mts cts");
add("code", "vue svelte astro php py rb go rs java kt c h cpp cs swift dart sql");
add("data", "json jsonc json5 xml");
add("config", "yml yaml toml ini conf env cfg htaccess");
add("image", "png jpg jpeg gif webp avif svg ico bmp tiff");
add("video", "mp4 webm mov avi mkv");
add("audio", "mp3 wav ogg m4a flac aac");
add("archive", "zip tar gz tgz rar 7z bz2 xz");
add("text", "txt md mdx pdf rtf log");
add("sheet", "csv tsv xls xlsx ods");
add("font", "woff woff2 ttf otf eot");
add("shell", "sh bash zsh ps1 bat cmd");
add("lock", "lock pem key crt");

/** A file's kind from its name: the extension, or the whole name for dotfiles like .env. */
export function fileKind(name: string): Kind | null {
  const base = name.split("/").pop()!.toLowerCase();
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  return KINDS[BY_EXTENSION[ext]] ?? null;
}

/** An icon for a file by its extension — a plain file for anything unknown. */
export function FileTypeIcon({ name, className = "h-4 w-4 shrink-0" }: { name: string; className?: string }) {
  const kind = fileKind(name);
  const Icon = kind?.icon ?? File;
  return <Icon className={`${className} ${kind?.color ?? "text-muted-foreground"}`} aria-hidden />;
}
