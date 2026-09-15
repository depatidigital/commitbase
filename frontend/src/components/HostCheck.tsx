import { AlertCircle, CheckCircle, Wifi, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { HostnameHealth } from "@/lib/applications";
import { t } from "@/lib/i18n";

/**
 * What the live check found for one of an app's names: whether it answers,
 * and whether it answers from this app's server. Shared by the overview (the
 * names that need attention) and the Domains tab (every name).
 */

// functions, so t() reads the dictionary at render, not at import
const DOMAIN_PROBLEM: Record<"unregistered" | "expired" | "suspended" | "inactive", () => string> = {
  unregistered: () => t("domain not registered"),
  expired: () => t("domain expired"),
  suspended: () => t("domain suspended"),
  inactive: () => t("domain inactive"),
};

/** Serving, from this server, and its registration is fine. Not checked yet counts as fine — nothing to show. */
export const hostOk = (check?: HostnameHealth) =>
  !check || (check.live && check.pointing?.state !== "elsewhere" && !check.domainProblem);

/** Answers, reachable elsewhere, not serving — and "Point it here" when that is what would fix it. */
export function HostBadge({
  host,
  check,
  pending,
  onRepoint,
  iconOnly = false,
}: {
  host: string;
  check?: HostnameHealth;
  pending?: boolean;
  /** overwrites whatever the record points at — the caller asks first */
  onRepoint?: () => void;
  /** the mark alone, what it means on hover — for a compact list */
  iconOnly?: boolean;
}) {
  if (!check) return null;
  if (iconOnly) {
    // the same verdicts as below, as one coloured icon
    const [Icon, color, label, detail] = check.domainProblem
      ? [AlertCircle, "text-destructive", DOMAIN_PROBLEM[check.domainProblem](), check.registeredDomain ?? host]
      : check.live && check.pointing?.state === "elsewhere"
        ? [Wifi, "text-warning", t("reachable elsewhere"), t("DNS points to {ip}", { ip: check.pointing.origin ?? check.pointing.addresses.join(", ") })]
        : check.live
          ? [Wifi, "text-success", t("reachable"), ""]
          : [WifiOff, "text-warning", check.resolves ? t("not serving yet") : check.dnsManaged ? t("no DNS") : t("not connected"), check.error ?? ""];
    const text = detail ? `${label} — ${detail}` : label;
    return (
      <span title={text} aria-label={text} className="inline-flex shrink-0">
        <Icon className={`h-3.5 w-3.5 ${color}`} />
      </span>
    );
  }
  // the registration first: an expired domain can still "answer" — with a parking page
  if (check.domainProblem) {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-destructive text-destructive"
        title={t("{domain} at the registry: {problem}", {
          domain: check.registeredDomain ?? host,
          problem: DOMAIN_PROBLEM[check.domainProblem](),
        })}
      >
        <AlertCircle className="h-3 w-3" />
        {DOMAIN_PROBLEM[check.domainProblem]()}
      </Badge>
    );
  }
  if (check.live && check.pointing?.state === "elsewhere") {
    // it answers — from someone else's server
    return (
      <Badge
        variant="outline"
        className="gap-1 border-warning text-warning"
        title={t("DNS points to {ip}", { ip: check.pointing.origin ?? check.pointing.addresses.join(", ") })}
      >
        <Wifi className="h-3 w-3" />
        {t("reachable elsewhere")}
      </Badge>
    );
  }
  if (check.live) {
    return (
      <Badge className="gap-1 bg-success text-success-foreground hover:bg-success/90">
        <Wifi className="h-3 w-3" />
        {t("reachable")}
      </Badge>
    );
  }
  return (
    <>
      <Badge
        variant="outline"
        className="gap-1 border-warning text-warning"
        title={
          check.resolves
            ? check.error ?? undefined
            : check.dnsManaged
              ? t("{domain} has no DNS record, so browsers cannot find this server. Point it here to fix it.", { domain: host })
              : t("{domain} has no DNS record, and its domain is not on Cloudflare here — add the record wherever its DNS is hosted.", { domain: host })
        }
      >
        <WifiOff className="h-3 w-3" />
        {/* no record, and its domain is not a zone we run: not connected to the panel at all */}
        {check.resolves ? t("not serving yet") : check.dnsManaged ? t("no DNS") : t("not connected")}
      </Badge>
      {/* only a Cloudflare zone we run can take the record — anywhere else the button could only fail.
          Already pointing here: DNS is not the problem, the app not answering is */}
      {onRepoint && check.dnsManaged && check.pointing?.state !== "here" && (
        <Button variant="outline" size="sm" className="h-6" disabled={pending} onClick={onRepoint}>
          {t("Point it here")}
        </Button>
      )}
    </>
  );
}

/** Where the name's DNS leads, next to this app's server. Nothing when it has no record. */
export function HostPointing({ check }: { check?: HostnameHealth }) {
  const pointing = check?.pointing;
  if (!pointing || pointing.state === "none") return null;
  if (pointing.state === "here") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-success">
        <CheckCircle className="h-3.5 w-3.5 shrink-0" />
        {t("This server")}
        <span className="font-mono text-muted-foreground">{pointing.expected}</span>
      </span>
    );
  }
  if (pointing.state === "elsewhere") {
    return (
      <span className="inline-flex flex-wrap items-center justify-end gap-1 text-xs text-destructive">
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        <span className="break-all font-mono">{pointing.origin ?? pointing.addresses.join(", ")}</span>
        {t("Not this server ({ip})", { ip: pointing.expected ?? "—" })}
      </span>
    );
  }
  return (
    <span
      className="text-xs text-muted-foreground"
      title={t("Cloudflare's proxy hides the real server, and this domain is not on Cloudflare here, so the record cannot be read.")}
    >
      {t("Cloudflare proxy — origin unknown")}
    </span>
  );
}
