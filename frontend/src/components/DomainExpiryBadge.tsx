import { Link } from "react-router-dom";
import { CalendarClock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { isAdmin } from "@/lib/auth";
import { expiryTone } from "@/lib/domainExpiry";
import { locale, t } from "@/lib/i18n";

export type ParentDomain = { id: string; name: string; expiresAt?: string | null; shared?: boolean };

/**
 * The app's domain registration running out — shown only when it matters:
 * expired, or inside the 30-day renewal window. A shared platform domain is
 * the operator's to renew, so only admins see it. Admins get a link to renew.
 */
export function DomainExpiryBadge({ domain }: { domain?: ParentDomain | null }) {
  const admin = isAdmin();
  if (!domain?.expiresAt || (domain.shared && !admin)) return null;

  const expiresAt = new Date(domain.expiresAt);
  const tone = expiryTone(expiresAt);
  if (!tone.urgent) return null;

  const expired = tone.days < 0;
  const label = expired
    ? t("Domain expired")
    : tone.days === 0
      ? t("Domain expires today")
      : t("Domain expires in {days}d", { days: tone.days });
  const badge = (
    <Badge
      variant="outline"
      className={`shrink-0 gap-1 ${tone.days <= 7 ? "border-destructive text-destructive" : "border-warning text-warning"}`}
      title={t("{name} registration {state} {date}", {
        name: domain.name,
        state: expired ? t("expired on") : t("expires on"),
        date: expiresAt.toLocaleDateString(locale),
      })}
    >
      <CalendarClock className="h-3 w-3" />
      {label}
    </Badge>
  );

  // renewing is an admin action (POST /domains/:id/renew), on the domain's page
  return admin ? <Link to={`/domains/${domain.id}`}>{badge}</Link> : badge;
}
