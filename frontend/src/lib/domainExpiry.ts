import { t } from "@/lib/i18n";

export type ExpiryTone = {
  days: number;
  className: string;
  note: string;
  urgent: boolean;
};

/** How loudly to shout about a registration expiry date. */
export const expiryTone = (value: Date): ExpiryTone => {
  const days = Math.ceil((value.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

  if (days < 0) return { days, className: "text-destructive font-semibold", note: t("expired"), urgent: true };
  if (days === 0) return { days, className: "text-destructive font-semibold", note: t("expires today"), urgent: true };
  if (days <= 7) return { days, className: "text-destructive font-semibold", note: t("{days}d left", { days }), urgent: true };
  if (days <= 30) return { days, className: "text-warning font-medium", note: t("{days}d left", { days }), urgent: true };
  if (days <= 60) return { days, className: "text-warning", note: t("{days}d left", { days }), urgent: false };
  return { days, className: "", note: "", urgent: false };
};

// expired, or inside the 30-day window the Expires column already highlights
export const needsRenewal = (domain: { expiresAt?: string | null }) =>
  !!domain.expiresAt && expiryTone(new Date(domain.expiresAt)).urgent;
