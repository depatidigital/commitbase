import { Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import type { HostnameHealth } from "@/lib/applications";
import { t } from "@/lib/i18n";

type Props = {
  /** the name that answers from another server */
  host: string;
  pointing: NonNullable<HostnameHealth["pointing"]> | null;
  dnsManaged: boolean;
  /** a proxy whose port had nothing listening at the last sync */
  portDead: boolean;
  port?: number | null;
  canManage: boolean;
  /** the DNS change is running — the confirm dialog has closed, so this is the only feedback */
  pending: boolean;
  onRepoint: () => void;
};

/**
 * Side-panel fix for "answers, but from another server": point the name at
 * this server — one click in a Cloudflare zone we run, the record to set
 * anywhere else — with a heads-up when nothing listens here yet.
 */
export function DnsFixCard({ host, pointing, dnsManaged, portDead, port, canManage, pending, onRepoint }: Props) {
  const { toast } = useToast();
  const expected = pointing?.expected ?? "";
  const record = `${host}  A  ${expected}`;

  return (
    <Card className="border-warning/50 bg-gradient-card">
      <CardContent className="space-y-2 p-4 text-sm">
        <h3 className="font-semibold">{t("How to fix")}</h3>
        {dnsManaged ? (
          canManage && (
            <Button className="w-full" disabled={pending} onClick={onRepoint}>
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {pending ? t("Changing DNS…") : t("Point it here")}
            </Button>
          )
        ) : (
          <div className="flex items-center gap-2 rounded bg-muted px-2 py-1.5">
            <code className="min-w-0 flex-1 break-all text-xs">{record}</code>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 shrink-0 p-0"
              aria-label={t("Copy")}
              onClick={() => {
                void navigator.clipboard?.writeText(record);
                toast({ title: t("Copied") });
              }}
            >
              <Copy className="h-3 w-3" />
            </Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {dnsManaged
            ? t("Replaces the Cloudflare record with {ip}.", { ip: expected })
            : t("Set this record at your DNS provider (DNS only).")}
        </p>
        {/* a heads-up, not a gate: the operator may be moving it here right now */}
        {portDead && (
          <p className="text-xs text-warning">
            {t("Port {port} is not listening yet — the site answers here once the app runs.", { port: port ?? "—" })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
