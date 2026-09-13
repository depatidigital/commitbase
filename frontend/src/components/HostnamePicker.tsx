import { useState } from "react";
import { Check, ChevronsUpDown, Globe } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { DomainChoice } from "@/lib/domains";
import { t } from "@/lib/i18n";

/** `sub` + `domain` → the hostname; an empty subdomain means the root domain. */
export const joinHost = (subdomain: string, domain: string) => (subdomain ? `${subdomain}.${domain}` : domain);

/**
 * A name under a shared platform domain must be one label and never its root —
 * the root and deeper trees are the platform's. Owned domains allow anything.
 */
export const hostnameProblem = (subdomain: string, choice: DomainChoice | undefined): string | null => {
  if (!choice) return t("Select a domain");
  if (choice.shared && !subdomain) return t("Pick a name under {domain}", { domain: choice.name });
  if (choice.shared && subdomain.includes(".")) return t("One name only — no dots");
  return null;
};

/**
 * Subdomain + domain, for creating an app and for moving it. Shared platform
 * domains come first and are marked: every app can live there for free.
 */
export function HostnamePicker({
  choices,
  subdomain,
  domain,
  onSubdomain,
  onDomain,
}: {
  choices: DomainChoice[];
  subdomain: string;
  domain: string;
  onSubdomain: (value: string) => void;
  onDomain: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const picked = choices.find((choice) => choice.name === domain);
  const problem = hostnameProblem(subdomain, picked);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Globe className="min-w-4 min-h-4 text-muted-foreground" />
        <Input
          id="subdomain"
          placeholder="app"
          value={subdomain}
          onChange={(e) => onSubdomain(e.target.value.trim().toLowerCase())}
        />
        <span className="text-muted-foreground">.</span>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              id="domain-select"
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              aria-invalid={!domain}
              // red until picked — whatever saves it stays disabled without it
              className={`w-full justify-between bg-card font-normal ${
                domain ? "" : "border-destructive text-destructive hover:text-destructive"
              }`}
            >
              <span className="truncate">{domain || t("Select a domain")}</span>
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-0" align="end">
            {/* the whole list is already loaded, so cmdk filters it locally */}
            <Command>
              <CommandInput placeholder={t("Search domains…")} />
              <CommandList>
                <CommandEmpty>{t("No domains found.")}</CommandEmpty>
                <CommandGroup>
                  {choices.map((choice) => {
                    const apps = choice._count?.applications ?? 0;
                    return (
                      <CommandItem
                        key={choice.id}
                        value={choice.name}
                        onSelect={() => {
                          onDomain(choice.name);
                          setOpen(false);
                        }}
                      >
                        <Check className={`mr-2 h-4 w-4 shrink-0 ${domain === choice.name ? "opacity-100" : "opacity-0"}`} />
                        <span className="flex-1 truncate">{choice.name}</span>
                        {choice.shared ? (
                          <Badge variant="secondary" className="ml-2 shrink-0 text-xs">
                            {t("free")}
                          </Badge>
                        ) : (
                          <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                            {apps === 0
                              ? t("Unused")
                              : apps === 1
                                ? t("{count} app", { count: apps })
                                : t("{count} apps", { count: apps })}
                          </span>
                        )}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
      {/* the result and the hint on one line */}
      <p className="text-xs text-muted-foreground">
        {domain && !problem && (
          <>
            <span className="font-mono text-foreground">{joinHost(subdomain, domain)}</span>
            {" · "}
          </>
        )}
        {picked?.shared ? (
          <span className={problem ? "text-destructive" : undefined}>
            {problem ?? t("A free address — add your own domain any time from the app's Domains tab.")}
          </span>
        ) : (
          t("Leave the subdomain empty to use the root domain.")
        )}
      </p>
    </div>
  );
}
