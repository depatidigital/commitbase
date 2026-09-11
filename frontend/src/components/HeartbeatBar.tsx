import type { Health } from "@/lib/health";
import { locale, t } from "@/lib/i18n";

/**
 * A bar per check, newest on the right.
 *
 * A status dot answers "is it up?" and nothing else. This answers "has it been
 * flapping?", "when did it break?" and "was it already like this before the
 * deploy?" in the same space, which is why every monitoring tool converges on
 * the same shape.
 */
export const HeartbeatBar = ({
  health,
  bars = 30,
}: {
  health?: Health;
  bars?: number;
}) => {
  // stored newest first; drawn oldest to newest, padded so short histories
  // stay right-aligned instead of stretching to fill
  const beats = [...(health?.beats ?? [])].reverse().slice(-bars);
  const padding = Math.max(0, bars - beats.length);

  return (
    <div className="flex h-6 items-end gap-[2px]" aria-hidden={!health}>
      {Array.from({ length: padding }).map((_, i) => (
        <span key={`pad-${i}`} className="h-3 w-[3px] rounded-sm bg-muted" />
      ))}
      {beats.map((beat, i) => (
        <span
          key={i}
          title={`${new Date(beat.at).toLocaleString(locale)} — ${
            beat.ok ? t("up") : beat.error || t("down")
          }${beat.responseMs ? ` · ${beat.responseMs}ms` : ""}`}
          className={`w-[3px] rounded-sm ${
            beat.ok ? "h-5 bg-success" : "h-6 bg-destructive"
          }`}
        />
      ))}
    </div>
  );
};

/** Word and colour for a health state, used wherever a status is written out. */
export const healthLabel = (health?: Health) => {
  switch (health?.state) {
    case "up":
      return { text: t("up"), className: "text-success" };
    case "down":
      return { text: t("down"), className: "text-destructive" };
    case "pending":
      // failing, but not yet often enough to be an outage — saying "down" here
      // is how a dashboard teaches people to ignore it
      return { text: t("pending"), className: "text-warning" };
    default:
      return { text: t("no data"), className: "text-muted-foreground" };
  }
};

export default HeartbeatBar;
