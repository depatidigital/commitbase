import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Globe, Loader2, Search, Sparkles } from "lucide-react";

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
import { locale, t } from "@/lib/i18n";

/** Periods the registrar sells this extension for, cheapest first. */
const periodOptions = (offer: DomainOffer): number[] => {
  const periods = Object.keys(offer.periods)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);

  // no price list (RDASH unreachable): keep a one-year row so the panel still
  // renders — registering stays blocked until a price comes back
  return periods.length > 0 ? periods : [1];
};

const money = (amount: number | null, currency: string) =>
  amount === null
    ? t("Price unavailable")
    : new Intl.NumberFormat(locale, {
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
              {t("Checking availability…")}
            </span>
          ) : offer.owned ? (
            t("Already managed in {app}", { app: APP_NAME })
          ) : offer.available === true ? (
            t("Available")
          ) : offer.available === false ? (
            offer.registrar ? (
              t("Taken — {registrar}", { registrar: offer.registrar })
            ) : (
              t("Taken")
            )
          ) : offer.checkFailed ? (
            t("Could not reach the availability check — search again")
          ) : (
            t("No registry answered — cannot register here")
          )}
        </div>
      </div>
      {(registrable || checking) && (
        <div className="shrink-0 text-right">
          <div className="text-sm font-medium">
            {money(offer.periods[1] ?? null, offer.currency)}
          </div>
          <div className="text-xs text-muted-foreground">{t("for 1 year")}</div>
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
  // registering spends real money, so it never happens on a single click
  const [confirming, setConfirming] = useState(false);

  const [term, setTerm] = useState("");
  const [idea, setIdea] = useState("");
  const [context, setContext] = useState("");

  // one per tab, so switching tabs does not throw away the other's results
  const lookup = useDomainSearch();
  const ideas = useDomainSearch();

  const registerDomain = useRegisterDomain();
  // never ask the admin to approve a charge they cannot see
  const priced = selected?.periods[years] != null;

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
    setConfirming(false);

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
      title={t("Register a domain")}
      backTo="/domains"
      icon={Globe}
      description={t(
        "Search the registry, then register through the {app} registrar account.",
        { app: APP_NAME },
      )}
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Tabs defaultValue="search" className="space-y-4">
          <TabsList>
            <TabsTrigger value="search" className="gap-2">
              <Search className="h-4 w-4" />
              {t("Search")}
            </TabsTrigger>
            <TabsTrigger value="suggest" className="gap-2">
              <Sparkles className="h-4 w-4" />
              {t("AI suggestions")}
            </TabsTrigger>
          </TabsList>

          {/* exact name, across the extensions we sell */}
          <TabsContent value="search" className="space-y-4">
            <form onSubmit={runSearch} className="space-y-2">
              <Label htmlFor="domain-search">{t("Search for a domain")}</Label>
              <div className="flex gap-2">
                <Input
                  id="domain-search"
                  placeholder={t("mycompany or mycompany.com")}
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
                  <span className="ml-2">{t("Check")}</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("Availability comes from the domain registry.")}
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
                    {t("Show all extensions")}
                  </Button>
                )}
              </div>
            )}
          </TabsContent>

          {/* names invented for the brief, then checked like any other */}
          <TabsContent value="suggest" className="space-y-4">
            <form onSubmit={runSuggest} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="domain-idea">{t("Keyword or theme")}</Label>
                <Input
                  id="domain-idea"
                  placeholder="desa digital"
                  value={idea}
                  onChange={(e) => setIdea(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="domain-context" className="text-sm">
                  {t("Brief")}{" "}
                  <span className="font-normal text-muted-foreground">
                    {t("(optional) — describe it, or say how to build the names")}
                  </span>
                </Label>
                <Textarea
                  id="domain-context"
                  rows={3}
                  maxLength={400}
                  placeholder={`Layanan administrasi untuk pemerintah desa di Indonesia.
Atau beri instruksi: "lebih pendek, ganti kata sinergi dengan kata lain, tetap Bahasa Indonesia".`}
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
                {t("Suggest names")}
              </Button>
              <p className="text-xs text-muted-foreground">
                {t(
                  "The brief is followed over the default naming rules, so you can ask for a specific style, length or wording. Every name is still checked against the registry.",
                )}
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
                  {t("Load more ideas")}
                </Button>
              </div>
            )}

            {ideas.offers && ideas.offers.length === 0 && !ideas.suggesting && (
              <p className="rounded-md border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
                {t("No names came back. Try a different keyword or description.")}
              </p>
            )}
          </TabsContent>
        </Tabs>

        <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <div className="space-y-2 rounded-md border border-border/60 p-4">
            <Label className="text-sm">{t("Owning organization")}</Label>
            <OrganizationCombobox
              value={organizationId || null}
              onChange={(id) => setOrganizationId(id ?? "")}
            />
            <p className="text-xs text-muted-foreground">
              {t("Only this organization's members can create applications on it.")}
            </p>
          </div>

          <div className="space-y-3 rounded-md border border-border/60 p-4">
            {selected ? (
              <>
                <div className="font-medium">{selected.domain}</div>
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="register-years" className="text-sm">
                    {t("Registration period")}
                  </Label>
                  <select
                    id="register-years"
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    value={years}
                    onChange={(e) => setYears(Number(e.target.value))}
                  >
                    {periodOptions(selected).map((n) => (
                      <option key={n} value={n}>
                        {n > 1
                          ? t("{count} years — {price}", {
                              count: n,
                              price: money(selected.periods[n] ?? null, selected.currency),
                            })
                          : t("{count} year — {price}", {
                              count: n,
                              price: money(selected.periods[n] ?? null, selected.currency),
                            })}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{t("Total")}</span>
                  <span className="font-medium">
                    {money(selected.periods[years] ?? null, selected.currency)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("Renews at {price} for 1 year.", {
                    price: money(selected.renewalPeriods[1] ?? null, selected.currency),
                  })}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("Pick an available domain to continue.")}
              </p>
            )}

            <Button
              type="button"
              className="w-full bg-gradient-primary"
              onClick={() => setConfirming(true)}
              disabled={
                registerDomain.isPending || !selected || !priced || !organizationId
              }
            >
              {registerDomain.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {selected
                ? t("Register {domain}", { domain: selected.domain })
                : t("Register domain")}
            </Button>
            <AlertDialog open={confirming} onOpenChange={setConfirming}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {years > 1
                      ? t("Register {domain} for {count} years?", {
                          domain: selected?.domain ?? "",
                          count: years,
                        })
                      : t("Register {domain} for {count} year?", {
                          domain: selected?.domain ?? "",
                          count: years,
                        })}
                  </AlertDialogTitle>
                  <AlertDialogDescription asChild>
                    <div className="space-y-2">
                      <p>
                        {t(
                          "This buys the domain from the registrar and charges the {app} account",
                          { app: APP_NAME },
                        )}{" "}
                        <strong>
                          {selected
                            ? money(
                                selected.periods[years] ?? null,
                                selected.currency,
                              )
                            : ""}
                        </strong>
                        .{" "}
                        {t("Domain registrations cannot be refunded or cancelled.")}
                      </p>
                      <p>
                        {t("It renews at {price} per year.", {
                          price: selected
                            ? money(
                                selected.renewalPeriods[1] ?? null,
                                selected.currency,
                              )
                            : "",
                        })}
                      </p>
                    </div>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={register}>
                    {t("Yes, register and pay")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            {selected && !priced && (
              <p className="text-xs text-muted-foreground">
                {t(
                  "The price could not be loaded, so this cannot be registered yet. Try again shortly.",
                )}
              </p>
            )}

            {selected && !organizationId && (
              <p className="text-xs text-muted-foreground">
                {t("Choose an owning organization first.")}
              </p>
            )}
          </div>
        </div>
      </div>
    </PageLayout>
  );
};

export default DomainRegister;
