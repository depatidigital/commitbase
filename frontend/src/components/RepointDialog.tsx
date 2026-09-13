import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { type Application, checkHostname } from "@/lib/applications";
import { t } from "@/lib/i18n";

/**
 * "Point it here" overwrites the hostname's DNS record. When that record
 * points somewhere else it is often a live site — so say where, before.
 */
export function RepointDialog({
  application,
  onClose,
  onConfirm,
}: {
  application: Pick<Application, "id" | "domain">;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["hostname-check", application.domain, application.id],
    queryFn: () => checkHostname(application.domain, application.id),
  });
  const elsewhere = data?.record && !data.record.pointsHere ? data.record : null;

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Point {host} at this app?", { host: application.domain })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("Its DNS record is set to this platform's server. Whatever it points at now stops receiving visitors.")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : elsewhere ? (
          <p className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {t("It now points to {target} ({type}). If a site runs there, it goes offline for this hostname.", {
              target: elsewhere.content,
              type: elsewhere.type,
            })}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={isLoading}
            className={elsewhere ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
            onClick={onConfirm}
          >
            {elsewhere ? t("Overwrite and point here") : t("Point it here")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
