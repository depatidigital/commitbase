import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Globe, Loader2, Search, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageLayout } from "@/components/PageLayout";
import { OrganizationCombobox } from "@/components/OrganizationCombobox";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useDomainSearch, useRegisterDomain } from "@/hooks/useDomains";
import type { DomainOffer } from "@/lib/domains";
import { APP_NAME } from "@/lib/branding";

/** Periods the registrar sells this extension for, cheapest first. */
const periodOptions = (offer: DomainOffer): number[] => {
  const periods = Object.keys(offer.periods)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);

  // an extension with no price list can still be registered — the registrar
  // quotes it at purchase time, so offer a plain one-year default
  return periods.length > 0 ? periods : [1];
};

const money = (amount: number | null, currency: string) =>
  amount === null
    ? "Price on request"
    : new Intl.NumberFormat("id-ID", {
        style: "currency",
        currency,
        maximumFractionDigits: 0,
      }).format(amount);

const DomainRegister = () => {
  const navigate = useNavigate();
  const [organizationId, setOrganizationId] = useState("");
  const [term, setTerm] = useState("");
  const [context, setContext] = useState("");
  const [selected, setSelected] = useState<DomainOffer | null>(null);
  const [years, setYears] = useState(1);

  const { offers, searching, suggesting, showingAll, search, suggest } =
    useDomainSearch();
  const registerDomain = useRegisterDomain();

  const busy = searching || suggesting;

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!term.trim()) return;
    setSelected(null);
    await search(term.trim());
  };

  const runSuggest = async () => {
    if (!term.trim()) return;
    setSelected(null);
    await suggest(term.trim(), context);
  };

  const showAll = async () => {
    if (!term.trim()) return;
    setSelected(null);
    await search(term.trim(), true);
  };

  const pick = (offer: DomainOffer) => {
    setSelected(offer);
    setYears(periodOptions(offer)[0]);
  };

  const register = async () => {
    if (!selected || !organizationId) return;

    try {
      await registerDomain.mutateAsync({
        name: selected.domain,
        organizationId,
        years,
      });
      navigate("/domains");
    } catch {
      // the mutation surfaces the registrar's own message
    }
  };

  return (
    <PageLayout
      title="Register a domain"
      backTo="/domains"
      icon={Globe}
      description={`Search the registry, then register through the ${APP_NAME} registrar account.`}
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <form onSubmit={runSearch} className="space-y-2">
            <Label htmlFor="domain-search">Search for a domain</Label>
            <div className="flex flex-wrap gap-2">
              <Input
                id="domain-search"
                className="min-w-[220px] flex-1"
                placeholder="mycompany or mycompany.com"
                value={term}
                onChange={(e) => setTerm(e.target.value)}
              />
              <Button type="submit" disabled={busy || !term.trim()}>
                {searching ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
                <span className="ml-2">Check</span>
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy || !term.trim()}
                onClick={runSuggest}
              >
                {suggesting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                <span className="ml-2">Suggest names</span>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Availability comes from the domain registry. Suggestions are AI
              ideas — every one is still checked against the registry.
            </p>

            <div className="space-y-1.5 pt-1">
              <Label htmlFor="domain-context" className="text-sm">
                What is it for?{" "}
                <span className="font-normal text-muted-foreground">
                  (optional, guides the suggestions)
                </span>
              </Label>
              <Textarea
                id="domain-context"
                rows={2}
                maxLength={400}
                placeholder="Platform layanan administrasi untuk pemerintah desa di Indonesia — warga urus surat online."
                value={context}
                onChange={(e) => setContext(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Describe the audience and what it does. Names are drawn from
                this, not just the keyword.
              </p>
            </div>
          </form>

          {offers && offers.length === 0 && !busy && (
            <p className="rounded-md border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
              No names came back. Try a different keyword.
            </p>
          )}

          {offers && offers.length > 0 && (
            <div className="space-y-2">
              {offers.map((offer) => {
                const checking = offer.available === undefined;
                const registrable = offer.available === true && !offer.owned;
                const active = selected?.domain === offer.domain;

                return (
                  <button
                    key={offer.domain}
                    type="button"
                    disabled={!registrable}
                    onClick={() => pick(offer)}
                    className={`flex w-full items-center justify-between gap-3 rounded-md border p-3 text-left transition-colors ${
                      active
                        ? "border-primary bg-primary/5"
                        : "border-border/60 bg-muted/20"
                    } ${
                      registrable
                        ? "hover:border-primary/60"
                        : "cursor-not-allowed opacity-60"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">
                          {offer.domain}
                        </span>
                        {offer.suggested && (
                          <Badge variant="secondary" className="shrink-0 gap-1">
                            <Sparkles className="h-3 w-3" />
                            AI
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {checking ? (
                          <span className="flex items-center gap-1.5">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Checking availability…
                          </span>
                        ) : offer.owned ? (
                          `Already managed in ${APP_NAME}`
                        ) : offer.available === true ? (
                          "Available"
                        ) : offer.available === false ? (
                          `Taken${offer.registrar ? ` — ${offer.registrar}` : ""}`
                        ) : offer.checkFailed ? (
                          "Could not reach the availability check — search again"
                        ) : (
                          "No registry answered — cannot register here"
                        )}
                      </div>
                    </div>
                    {(registrable || checking) && (
                      <div className="shrink-0 text-right">
                        <div className="text-sm font-medium">
                          {money(offer.periods[1] ?? null, offer.currency)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          for 1 year
                        </div>
                      </div>
                    )}
                  </button>
                );
              })}

              {!showingAll && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  disabled={busy}
                  onClick={showAll}
                >
                  Show all extensions
                </Button>
              )}
            </div>
          )}
        </div>

        <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <div className="space-y-2 rounded-md border border-border/60 p-4">
            <Label className="text-sm">Owning organization</Label>
            <OrganizationCombobox
              value={organizationId || null}
              onChange={(id) => setOrganizationId(id ?? "")}
            />
            <p className="text-xs text-muted-foreground">
              Only this organization's members can create applications on it.
            </p>
          </div>

          <div className="space-y-3 rounded-md border border-border/60 p-4">
            {selected ? (
              <>
                <div className="font-medium">{selected.domain}</div>
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="register-years" className="text-sm">
                    Registration period
                  </Label>
                  <select
                    id="register-years"
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    value={years}
                    onChange={(e) => setYears(Number(e.target.value))}
                  >
                    {periodOptions(selected).map((n) => (
                      <option key={n} value={n}>
                        {n} year{n > 1 ? "s" : ""} —{" "}
                        {money(selected.periods[n] ?? null, selected.currency)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Total</span>
                  <span className="font-medium">
                    {money(selected.periods[years] ?? null, selected.currency)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Renews at{" "}
                  {money(selected.renewalPeriods[1] ?? null, selected.currency)}{" "}
                  for 1 year.
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Pick an available domain to continue.
              </p>
            )}

            <Button
              type="button"
              className="w-full bg-gradient-primary"
              onClick={register}
              disabled={
                registerDomain.isPending || !selected || !organizationId
              }
            >
              {registerDomain.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {selected ? `Register ${selected.domain}` : "Register domain"}
            </Button>
            {selected && !organizationId && (
              <p className="text-xs text-muted-foreground">
                Choose an owning organization first.
              </p>
            )}
          </div>
        </div>
      </div>
    </PageLayout>
  );
};

export default DomainRegister;
