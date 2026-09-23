import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { t } from "./i18n"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** "1.3 GB" — bytes in the largest unit that keeps the number under 1024. */
export function formatBytes(bytes?: number | null, locale = "en-US"): string {
  if (bytes == null) return "—"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toLocaleString(locale, { maximumFractionDigits: unit < 2 ? 0 : 1 })} ${units[unit]}`
}

/** Compact relative time — "3d ago". Callers put the exact stamp in a title. */
export function timeAgo(value: string | Date): string {
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000)
  if (seconds < 3600) return t("{n}m ago", { n: Math.floor(seconds / 60) })
  if (seconds < 86400) return t("{n}h ago", { n: Math.floor(seconds / 3600) })
  return t("{n}d ago", { n: Math.floor(seconds / 86400) })
}
