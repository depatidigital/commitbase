import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
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
import { DnsChangeNotice } from "@/components/DnsChangeNotice";
import { type AppDomain, checkHostname, dnsNeedsConsent } from "@/lib/applications";
import { t } from "@/lib/i18n";

/**
 * "Point it here" replaces the hostname's DNS records (and may move a
 * registrar domain to Cloudflare). It says exactly what, before.
 */
export function RepointDialog({
  applicationId,
  name,
  onClose,
  onConfirm,
}: {
  applicationId: string;
  /** which of the app's names, and the domain it sits under */
  name: Pick<AppDomain, "host" | "parentDomain">;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const host = name.host;
  const { data, isLoading } = useQuery({
    queryKey: ["hostname-check", host, applicationId],
    queryFn: () => checkHostname(host, { excludeAppId: applicationId }),
  });
  const consent = dnsNeedsConsent(data);
  const domain = name.parentDomain?.name ?? host;

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Point {host} at this service?", { host })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("Its DNS record is set to this platform's server. Whatever it points at now stops receiving visitors.")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : data ? (
          <DnsChangeNotice host={host} domain={domain} inspection={data} />
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={isLoading}
            className={consent ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
            onClick={onConfirm}
          >
            {consent ? t("I agree — change DNS") : t("Point it here")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
