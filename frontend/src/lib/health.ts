import apiRequest from "./api";
import { t } from "./i18n";

/** One recorded check. */
export interface Beat {
  at: string;
  ok: boolean;
  responseMs: number | null;
  httpStatus: number | null;
  error: string | null;
}

export interface Health {
  /** "pending" is failing, but not yet often enough to call an outage. */
  state: "up" | "down" | "pending" | "unknown";
  beats: Beat[];
  uptime24h: number | null;
  lastError: string | null;
  responseMs: number | null;
  /** answers, but its DNS leads to this other server — not ours */
  pointsElsewhere?: string;
}

export type Tone = "up" | "down" | "warn" | "deploying" | "muted";

/**
 * One word for "is it OK?", from the app's own status and the uptime checks —
 * the apps list's dot and the detail page's status card both read this, so
 * they cannot disagree. `rank` puts what needs a look first: broken, then in
 * flight, then fine.
 */
export const appStatus = (status: string, health?: Health, disabled = false): { text: string; tone: Tone; rank: number } => {
  // switched off in the panel: not watched, and last in line
  if (disabled) return { text: t("Disabled"), tone: "muted", rank: 9 };
  if (status === "DEPLOYING" || status === "BUILDING") return { text: t("Deploying"), tone: "deploying", rank: 1 };
  // stopped on purpose — not an outage, whatever the checks say
  if (status === "STOPPED") return { text: t("Stopped"), tone: "muted", rank: 3 };
  if (health?.state === "down") return { text: t("Down"), tone: "down", rank: 0 };
  // failing lately, not yet long enough to call it an outage
  if (health?.state === "pending") return { text: t("Unstable"), tone: "warn", rank: 0 };
  // answering from another server: up for someone, but not connected to this app's server
  if (health?.state === "up" && health.pointsElsewhere) return { text: t("Active, not connected"), tone: "warn", rank: 0 };
  if (health?.state === "up") return { text: t("Online"), tone: "up", rank: 2 };
  if (status === "ERROR") return { text: t("Error"), tone: "down", rank: 0 };
  return { text: t("Not monitored"), tone: "muted", rank: 4 };
};

/**
 * Health for a page of applications in one request — a call per row would be
 * 25 round trips for one screen.
 */
export const getApplicationHealth = async (
  ids: string[],
): Promise<Record<string, Health>> => {
  if (ids.length === 0) return {};

  const response = await apiRequest<Record<string, Health>>(
    `/applications/health?ids=${ids.join(",")}`,
  );

  if (response.success && response.data) return response.data;
  throw new Error(response.error || t("Failed to read health"));
};

/** One hostname (host + path) of a service, with its own uptime — the monitor page. */
export interface HostHealth {
  id: string;
  host: string;
  path: string;
  service: { id: string; name: string; status: string; disabled: boolean };
  /** the app (API: source) it belongs to */
  app: { id: string; name: string } | null;
  health: Health;
}

export const getHostHealth = async (): Promise<HostHealth[]> => {
  const response = await apiRequest<HostHealth[]>("/applications/health/hosts");
  if (response.success && response.data) return response.data;
  throw new Error(response.error || t("Failed to read health"));
};
