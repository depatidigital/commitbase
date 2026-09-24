import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Cloud, Cpu, HardDrive, Loader2, MemoryStick, TrendingUp, Wallet } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageLayout } from "@/components/PageLayout";
import { getUsage } from "@/lib/billing";
import { locale, t } from "@/lib/i18n";

const rupiah = (value: number) =>
  new Intl.NumberFormat(locale, { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Math.round(value));
const amount = (value: number, digits = 2) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);

/** The last six months, newest first: YYYY-MM, in Jakarta's calendar like the API. */
const months = () => {
  const now = new Date(Date.now() + 7 * 3_600_000);
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    return d.toISOString().slice(0, 7);
  });
};
const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "UTC" });

/**
 * What the workspace used this month and what it costs: pay for what you use.
 * CPU and memory metered every five minutes, storage as it is held — priced by
 * the hour. An estimate until billing exists: nothing is charged yet.
 */
export default function Billing() {
  const options = months();
  const [month, setMonth] = useState(options[0]!);
  const { data, isLoading, error } = useQuery({ queryKey: ["billing", "usage", month], queryFn: () => getUsage(month), refetchInterval: 5 * 60_000 });

  const rows = data
    ? [
        { icon: Cpu, label: t("CPU"), use: `${amount(data.usage.cpuCoreHours)} ${t("core-hours")}`, rate: `${rupiah(data.rates.cpuCoreHour)} / ${t("core-hour")}`, cost: data.cost.cpu },
        { icon: MemoryStick, label: t("Memory"), use: `${amount(data.usage.memGbHours)} ${t("GB-hours")}`, rate: `${rupiah(data.rates.memGbHour)} / ${t("GB-hour")}`, cost: data.cost.mem },
        {
          icon: HardDrive,
          label: t("Disk"),
          // held from the 1st, or since a service was made — by the day; the workspace's journal (container logs) in it
          use:
            `${amount(data.usage.storageGbDays)} ${t("GB-days")}` +
            (data.rate && data.rate.journalGb > 0 ? ` · ${t("incl. {size} GB journal logs", { size: amount(data.rate.journalGb, 3) })}` : ""),
          rate: `${rupiah(data.rates.storageGbMonth)} / ${t("GB-month")}`,
          cost: data.cost.storage,
        },
        {
          icon: Cloud,
          label: t("Object storage (R2)"),
          // static sites' files: cheaper than disk, no free space to keep
          use: `${amount(data.usage.objectGbDays)} ${t("GB-days")}`,
          rate: `${rupiah(data.rates.objectGbMonth)} / ${t("GB-month")}`,
          cost: data.cost.object,
        },
      ]
    : [];
  const peak = Math.max(1, ...(data?.days.map((d) => d.cost) ?? []));
  // every day of the month, the unmetered ones empty — one day is one thin bar, not the whole width
  const costOf = new Map(data?.days.map((d) => [d.date, d.cost]));
  const [year, mon] = month.split("-").map(Number) as [number, number];
  const monthDays = Array.from({ length: new Date(Date.UTC(year, mon, 0)).getUTCDate() }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);

  return (
    <PageLayout
      icon={Wallet}
      title={t("Usage")}
      description={t("Pay for what you use: CPU and memory metered every five minutes, storage as it is held.")}
      actions={
        <Select value={month} onValueChange={setMonth}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((m) => (
              <SelectItem key={m} value={m}>
                {monthLabel(m)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      {isLoading ? (
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      ) : error ? (
        <p className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {(error as Error).message}
        </p>
      ) : data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardContent className="p-5">
                <p className="text-sm text-muted-foreground">{t("{month} so far", { month: monthLabel(data.month) })}</p>
                <p className="text-3xl font-semibold">{rupiah(data.cost.total)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center justify-between p-5">
                <div>
                  {/* what this month will actually cost: so far, then the days left at the rate now —
                      what is charged. A full month at that rate under it: the forecast for next month */}
                  <p className="text-sm text-muted-foreground" title={t("So far, plus the days left at the rate now")}>
                    {t("Expected {month} bill", { month: monthLabel(data.month).split(" ")[0]! })}
                  </p>
                  <p className="text-3xl font-semibold">{data.projected !== null ? rupiah(data.projected) : "—"}</p>
                  {data.rate && (
                    <p className="mt-1 text-sm" title={t("A whole month at what is held now")}>
                      {t("Next month (full) ≈ {amount}", { amount: rupiah(data.rate.perHour * data.monthDays * 24) })}
                    </p>
                  )}
                  {data.rate && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("Now: {rate} per hour — {storage} GB on disk, {object} GB in R2, {memory} GB memory, {cpu} CPU cores", {
                        rate: rupiah(data.rate.perHour),
                        storage: amount(data.rate.storageGb),
                        object: amount(data.rate.objectGb, 3),
                        memory: amount(data.rate.memGb),
                        cpu: amount(data.rate.cpuCores, 3),
                      })}
                    </p>
                  )}
                </div>
                <TrendingUp className="h-6 w-6 text-muted-foreground" />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{t("By resource")}</CardTitle>
            </CardHeader>
            <CardContent className="divide-y">
              {rows.map((row) => (
                <div key={row.label} className="flex flex-wrap items-center gap-x-6 gap-y-1 py-3 text-sm">
                  <span className="flex w-32 items-center gap-2 font-medium">
                    <row.icon className="h-4 w-4 text-primary" />
                    {row.label}
                  </span>
                  <span className="min-w-40 flex-1 text-muted-foreground">{row.use}</span>
                  <span className="w-44 text-muted-foreground">{row.rate}</span>
                  <span className="w-32 text-right font-medium">{rupiah(row.cost)}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{t("By day")}</CardTitle>
            </CardHeader>
            <CardContent>
              {data.days.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("Nothing metered in this month yet.")}</p>
              ) : (
                // one bar per day, as tall as its cost against the month's busiest day
                <div className="space-y-1">
                  <div className="flex h-40 items-end gap-1">
                    {monthDays.map((date) => {
                      const cost = costOf.get(date);
                      return (
                        <div key={date} className="group flex h-full flex-1 flex-col justify-end" title={cost !== undefined ? `${date}: ${rupiah(cost)}` : date}>
                          {cost !== undefined && (
                            <div className="rounded-t bg-primary/70 group-hover:bg-primary" style={{ height: `${Math.max(2, (cost / peak) * 100)}%` }} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex justify-between text-[10px] text-muted-foreground">
                    <span>1</span>
                    <span>{monthDays.length}</span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            {t("An estimate: nothing is charged yet. Services imported from a server (pm2 of another user) are not metered.")}
          </p>
        </>
      ) : null}
    </PageLayout>
  );
}
