import { Link } from "react-router-dom";
import { DISK_AMBER_PCT, diskTone, diskUsedPct } from "@/lib/servers";
import { locale, t } from "@/lib/i18n";
import { formatBytes } from "@/lib/utils";

/**
 * How full a server's disk is: the share used, what is free, a bar — blue,
 * amber from DISK_AMBER_PCT, red from DISK_RED_PCT — and, once it is getting
 * full, the way to its cleanup. The server list and the dashboard alike.
 */
export function DiskBar({ serverId, disk }: { serverId: string; disk: { size: number; used: number; avail: number } | null }) {
  if (!disk) return <span className="text-xs text-muted-foreground">—</span>;
  const pct = diskUsedPct(disk);
  const { text, bar } = diskTone(pct);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className={text}>{pct}%</span>
        <span className="text-muted-foreground">{t("{free} free", { free: formatBytes(disk.avail, locale) })}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted" title={`${formatBytes(disk.used, locale)} / ${formatBytes(disk.size, locale)}`}>
        <div className={`h-full ${bar}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      {pct >= DISK_AMBER_PCT && (
        <Link to={`/servers/${serverId}?tab=storage`} onClick={(e) => e.stopPropagation()} className="text-xs text-primary hover:underline">
          {t("Clean up")}
        </Link>
      )}
    </div>
  );
}
