import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { t } from "@/lib/i18n";
import type { ProvisionState } from "@/lib/organizations";

/** State of a provisioning queue row — an organization's OS user or a server's setup. */
export function ProvisionBadge({
  state,
  error,
  at,
  waiting,
  onClick,
}: {
  state: ProvisionState;
  error?: string | null;
  at?: string | null;
  /** Shown instead of "Queued" when the job cannot start yet, e.g. an unplaced org. */
  waiting?: string;
  onClick?: () => void;
}) {
  const clickable = onClick ? "cursor-pointer" : undefined;
  switch (state) {
    case "DONE":
      return (
        <Badge className={clickable} onClick={onClick} title={at ? new Date(at).toLocaleString() : undefined}>
          {t("Provisioned")}
        </Badge>
      );
    case "RUNNING":
      return (
        <Badge variant="secondary" className={clickable} onClick={onClick}>
          <Loader2 className="mr-1 h-3 w-3 animate-spin" /> {t("Running")}
        </Badge>
      );
    case "QUEUED":
      return (
        <Badge variant="secondary" className={clickable} onClick={onClick}>
          {waiting ?? t("Queued")}
        </Badge>
      );
    case "FAILED":
      return (
        <Badge variant="destructive" className={clickable} onClick={onClick} title={error ?? undefined}>
          {t("Failed")}
        </Badge>
      );
    default:
      return <span className="text-xs text-muted-foreground">—</span>;
  }
}
