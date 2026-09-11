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
}

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
