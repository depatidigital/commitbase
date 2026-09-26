import { useState, type ElementType, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, AppWindow, Calculator, Cloud, Cpu, Globe, HardDrive, Image, Loader2, MemoryStick, MessageCircle, MessageSquare, Phone, Server, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageLayout } from "@/components/PageLayout";
import { getRates, type Rates } from "@/lib/billing";
import { locale, t } from "@/lib/i18n";

const rupiah = (value: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Math.round(value));
/** the meter's month: 730 hours */
const MONTH_H = 730;
/** a WhatsApp month: 30 linked days */
const WA_DAYS = 30;

function PriceRow({ icon: Icon, label, note, price, sub }: { icon: ElementType; label: string; note?: string; price: ReactNode; sub?: string }) {
  return (
    <div className="flex items-start gap-3 py-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
      <div className="text-right">
        <p className="text-sm font-semibold tabular-nums">{price}</p>
        {sub && <p className="text-xs text-muted-foreground tabular-nums">{sub}</p>}
      </div>
    </div>
  );
}

function Section({ icon: Icon, title, description, children }: { icon: ElementType; title: string; description: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="h-4 w-4 text-primary" />
          {title}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent className="divide-y">{children}</CardContent>
    </Card>
  );
}

/**
 * Every price on the platform in one place: apps (and their databases) metered
 * by what they use, WhatsApp numbers by the day and message, domains at their
 * registry's price. Rates come from the backend's price list, the one the meter
 * charges by.
 */
export default function Pricing() {
  const { data: rates, isLoading, error } = useQuery({ queryKey: ["billing", "rates"], queryFn: getRates, staleTime: 10 * 60_000 });

  return (
    <PageLayout icon={Tag} title={t("Pricing")} description={t("Pay only for what you use. Prices in rupiah, no minimum contract.")}>
      {isLoading ? (
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      ) : error || !rates ? (
        <p className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {(error as Error)?.message}
        </p>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <Section icon={AppWindow} title={t("Apps & databases")} description={t("Metered every five minutes from what your services and databases actually use. Nothing is charged for what they don't use.")}>
              <PriceRow icon={Cpu} label="CPU" note={t("Per vCPU in use")} price={`${rupiah(rates.apps.cpuCoreHour * MONTH_H)} / ${t("month")}`} sub={`${rupiah(rates.apps.cpuCoreHour)} / ${t("core-hour")}`} />
              <PriceRow icon={MemoryStick} label={t("Memory")} note={t("Per GB held")} price={`${rupiah(rates.apps.memGbHour * MONTH_H)} / ${t("month")}`} sub={`${rupiah(rates.apps.memGbHour)} / ${t("GB-hour")}`} />
              <PriceRow icon={HardDrive} label={t("Disk")} note={t("Files, databases and logs on the server; charged by the day")} price={`${rupiah(rates.apps.storageGbMonth)} / ${t("GB-month")}`} />
              <PriceRow icon={Cloud} label={t("Object storage (R2)")} note={t("Static sites' files")} price={`${rupiah(rates.apps.objectGbMonth)} / ${t("GB-month")}`} />
              <div className="pt-3">
                <Button asChild variant="outline" size="sm">
                  <Link to="/usage">{t("See your usage")}</Link>
                </Button>
              </div>
            </Section>

            <Section icon={Globe} title={t("Domains")} description={t("Registration and renewal at each extension's price, shown when you search for a domain.")}>
              <div className="pt-3">
                <Button asChild variant="outline" size="sm">
                  <Link to="/domains/register">{t("Search a domain")}</Link>
                </Button>
              </div>
            </Section>
          </div>

          <div className="space-y-4">
            <Section icon={MessageCircle} title="Whatsapp Gateway API" description={t("Per number: the days it is linked and what it sends. Receiving is free.")}>
              <PriceRow icon={Phone} label={t("Linked number")} note={t("Only the days it is linked")} price={`${rupiah(rates.wa.linkedDay)} / ${t("day")}`} sub={`≈ ${rupiah(rates.wa.linkedDay * WA_DAYS)} / ${t("month")}`} />
              <PriceRow icon={MessageSquare} label={t("Text messages")} note={t("First {count} per number per day", { count: rates.wa.freeTextsPerDay })} price={t("Free")} sub={t("then {price} each", { price: rupiah(rates.wa.textAfterFree) })} />
              <PriceRow icon={Image} label={t("Media messages")} note={t("Images, video, audio, documents")} price={`${rupiah(rates.wa.media)} / ${t("message")}`} />
              <PriceRow icon={MessageCircle} label={t("Incoming messages & webhooks")} price={t("Free")} />
              <PriceRow icon={Server} label={t("Own WA node")} note={t("Your own PC running WhatsApp sessions")} price={`${rupiah(rates.wa.ownNodeMonth)} / ${t("node-month")}`} />
              <p className="pt-3 text-xs text-muted-foreground">
                {t("Runs on WhatsApp linked devices, not the official Business API: a number WhatsApp bans is not refunded. Daily sending limits stay on to protect your numbers.")}
              </p>
            </Section>

            <Estimator rates={rates} />
          </div>
        </div>
      )}
    </PageLayout>
  );
}

/** A month's bill for a typical setup: a few inputs, the same prices. */
function Estimator({ rates }: { rates: Rates }) {
  const [v, setV] = useState({ cpu: "0.25", mem: "0.5", disk: "5", numbers: "1", texts: "100", media: "10" });
  const n = (key: keyof typeof v) => Math.max(0, Number(v[key]) || 0);
  const apps = n("cpu") * rates.apps.cpuCoreHour * MONTH_H + n("mem") * rates.apps.memGbHour * MONTH_H + n("disk") * rates.apps.storageGbMonth;
  const paidTexts = Math.max(0, n("texts") - rates.wa.freeTextsPerDay);
  const wa = n("numbers") * WA_DAYS * (rates.wa.linkedDay + paidTexts * rates.wa.textAfterFree + n("media") * rates.wa.media);

  const field = (key: keyof typeof v, label: string, step = "1") => (
    <div className="space-y-1">
      <Label htmlFor={`est-${key}`} className="text-xs">
        {label}
      </Label>
      <Input id={`est-${key}`} type="number" min="0" step={step} inputMode="decimal" value={v[key]} onChange={(e) => setV({ ...v, [key]: e.target.value })} />
    </div>
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Calculator className="h-4 w-4 text-primary" />
          {t("Estimate a month")}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{t("Average use over the month, not the peak.")}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          {field("cpu", t("vCPU"), "0.05")}
          {field("mem", t("Memory (GB)"), "0.25")}
          {field("disk", t("Disk (GB)"))}
          {field("numbers", t("WA numbers"))}
          {field("texts", t("Texts / day each"))}
          {field("media", t("Media / day each"))}
        </div>
        <div className="space-y-1 rounded-md bg-muted/50 p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("Apps & databases")}</span>
            <span className="tabular-nums">{rupiah(apps)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Whatsapp Gateway API</span>
            <span className="tabular-nums">{rupiah(wa)}</span>
          </div>
          <div className="flex justify-between border-t pt-1 font-semibold">
            <span>{t("Per month")}</span>
            <span className="tabular-nums">{rupiah(apps + wa)}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
