import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Globe, Loader2, Search, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageLayout } from "@/components/PageLayout";
import { OrganizationCombobox } from "@/components/OrganizationCombobox";
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

/** One result row. Shared by both tabs so they cannot drift apart. */
const OfferRow = ({
  offer,
  active,
  onPick,
}: {
  offer: DomainOffer;
  active: boolean;
  onPick: (offer: DomainOffer) => void;
}) => {
  const checking = offer.available === undefined;
  const registrable = offer.available === true && !offer.owned;

  return (
    <button
      type="button"
      disabled={!registrable}
      onClick={() => onPick(offer)}
      className={`flex w-full items-center justify-between gap-3 rounded-md border p-3 text-left transition-colors ${
        active ? "border-primary bg-primary/5" : "border-border/60 bg-muted/20"
      } ${
        registrable
          ? "hover:border-primary/60"
          : "cursor-not-allowed opacity-60"
      }`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{offer.domain}</span>
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
          <div className="text-xs text-muted-foreground">for 1 year</div>
        </div>
      )}
    </button>
  );
};

const DomainRegister = () => {
  const navigate = useNavigate();
  const [organizationId, setOrganizationId] = useState("");
  const [selected, setSelected] = useState<DomainOffer | null>(null);
  const [years, setYears] = useState(1);

  const [term, setTerm] = useState("");
  const [idea, setIdea] = useState("");
  const [context, setContext] = useState("");

  // one per tab, so switching tabs does not throw away the other's results
  const lookup = useDomainSearch();
  const ideas = useDomainSearch();

  const registerDomain = useRegisterDomain();

  const pick = (offer: DomainOffer) => {
    setSelected(offer);
    setYears(periodOptions(offer)[0]);
  };

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!term.trim()) return;
    setSelected(null);
    await lookup.search(term.trim());
  };

  const runSuggest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!idea.trim()) return;
    setSelected(null);
    await ideas.suggest(idea.trim(), context);
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
        <Tabs defaultValue="search" className="space-y-4">
          <TabsList>
            <TabsTrigger value="search" className="gap-2">
              <Search className="h-4 w-4" />
              Search
            </TabsTrigger>
            <TabsTrigger value="suggest" className="gap-2">
              <Sparkles className="h-4 w-4" />
              AI suggestions
            </TabsTrigger>
          </TabsList>

          {/* exact name, across the extensions we sell */}
          <TabsContent value="search" className="space-y-4">
            <form onSubmit={runSearch} className="space-y-2">
              <Label htmlFor="domain-search">Search for a domain</Label>
              <div className="flex gap-2">
                <Input
                  id="domain-search"
                  placeholder="mycompany or mycompany.com"
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                />
                <Button
                  type="submit"
                  disabled={lookup.searching || !term.trim()}
                >
                  {lookup.searching ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                  <span className="ml-2">Check</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Availability comes from the domain registry.
              </p>
            </form>

            {lookup.offers && (
              <div className="space-y-2">
                {lookup.offers.map((offer) => (
                  <OfferRow
                    key={offer.domain}
                    offer={offer}
                    active={selected?.domain === offer.domain}
                    onPick={pick}
                  />
                ))}

                {!lookup.showingAll && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    disabled={lookup.searching}
                    onClick={() => lookup.search(term.trim(), true)}
                  >
                    Show all extensions
                  </Button>
                )}
              </div>
            )}
          </TabsContent>

          {/* names invented for the brief, then checked like any other */}
          <TabsContent value="suggest" className="space-y-4">
            <form onSubmit={runSuggest} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="domain-idea">Keyword or theme</Label>
                <Input
                  id="domain-idea"
                  placeholder="desa digital"
                  value={idea}
                  onChange={(e) => setIdea(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="domain-context" className="text-sm">
                  What is it for?{" "}
                  <span className="font-normal text-muted-foreground">
                    (optional)
                  </span>
                </Label>
                <Textarea
                  id="domain-context"
                  rows={3}
                  maxLength={400}
                  placeholder="Platform layanan administrasi untuk pemerintah desa di Indonesia — warga urus surat online."
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                />
                <p className="text-right text-xs text-muted-foreground">
                  {context.length}/400
                </p>
              </div>

              <Button
                type="submit"
                disabled={ideas.suggesting || !idea.trim()}
                className="w-full"
              >
                {ideas.suggesting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="mr-2 h-4 w-4" />
                )}
                Suggest names
              </Button>
              <p className="text-xs text-muted-foreground">
                Names are drawn from the description, not just the keyword — and
                every one is checked against the registry.
              </p>
            </form>

            {ideas.offers && ideas.offers.length > 0 && (
              <div className="space-y-2">
                {ideas.offers.map((offer) => (
                  <OfferRow
                    key={offer.domain}
                    offer={offer}
                    active={selected?.domain === offer.domain}
                    onPick={pick}
                  />
                ))}

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  disabled={ideas.suggesting}
                  onClick={() => ideas.suggestMore(idea.trim(), context)}
                >
                  {ideas.suggesting && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Load more ideas
                </Button>
              </div>
            )}

            {ideas.offers && ideas.offers.length === 0 && !ideas.suggesting && (
              <p className="rounded-md border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
                No names came back. Try a different keyword or description.
              </p>
            )}
          </TabsContent>
        </Tabs>

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
