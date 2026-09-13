import { AlertTriangle, Info } from "lucide-react";
import { dnsNeedsConsent, type HostInspection } from "@/lib/applications";
import { t } from "@/lib/i18n";

/**
 * Exactly what pointing `host` at the app does to DNS, from the hostname check:
 * - Cloudflare zone, records elsewhere → they are deleted and an A record added;
 * - registrar (RDASH) domain → moved to Cloudflare first, then the same;
 * - DNS run elsewhere → nothing we can change, the user adds the record.
 * Nothing at all is shown when the name is free or already points here.
 */
export function DnsChangeNotice({ host, domain, inspection }: { host: string; domain: string; inspection: HostInspection }) {
  const target = inspection.target ? `${inspection.target.type} → ${inspection.target.content}` : t("this platform's server");
  const consent = dnsNeedsConsent(inspection);

  if (inspection.usedBy || inspection.pointsHere) return null;

  if (inspection.dns === "external") {
    return (
      <Notice tone="info">
        {t("The DNS of {domain} is not run here, so it cannot be changed automatically. Once the app exists, add this record where the domain's DNS is managed:", { domain })}
        <code className="mt-1 block text-xs">{host} {target}</code>
      </Notice>
    );
  }

  if (inspection.dns === "registrar" && !inspection.canMove) {
    return (
      <Notice tone="warn">
        {t("{domain} is still on the registrar's DNS (RDASH), not Cloudflare. An owner or admin of the organization has to move it to Cloudflare before {host} can reach this app.", { domain, host })}
      </Notice>
    );
  }

  if (!consent) {
    // a free name in a zone we run: the record is simply added
    return inspection.dns === "cloudflare" && inspection.target ? (
      <p className="text-xs text-muted-foreground">
        {t("DNS: {host} {target} is added automatically.", { host, target })}
      </p>
    ) : null;
  }

  return (
    <Notice tone="warn">
      <span className="font-medium">{t("DNS for {host} will be changed automatically:", { host })}</span>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
        {inspection.dns === "registrar" && (
          <li>
            {t("{domain} moves to Cloudflare: its current DNS records are copied, then the nameservers at RDASH are switched to Cloudflare. That can take a few hours to spread.", { domain })}
          </li>
        )}
        {inspection.replaces.map((record) => (
          <li key={`${record.type} ${record.content}`}>
            {t("Delete {type} → {content}", { type: record.type, content: record.content })}
          </li>
        ))}
        {inspection.dns === "registrar" && (
          <li>{t("Any record already at {host} is replaced", { host })}</li>
        )}
        <li>{t("Add {target}", { target })}</li>
      </ul>
      <span className="mt-1.5 block">
        {t("Whatever is served at {host} today stops receiving visitors.", { host })}
      </span>
    </Notice>
  );
}

function Notice({ tone, children }: { tone: "warn" | "info"; children: React.ReactNode }) {
  const Icon = tone === "warn" ? AlertTriangle : Info;
  return (
    <div
      className={`flex items-start gap-2 rounded-md border p-2.5 text-sm ${
        tone === "warn" ? "border-warning/50 bg-warning/5" : "border-border bg-muted/40"
      }`}
    >
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone === "warn" ? "text-warning" : "text-muted-foreground"}`} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
