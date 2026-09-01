import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { getOrganization, getOrganizationsPage } from "@/lib/organizations";

const PAGE_SIZE = 20;

type Props = {
  /** organization id, or null for the "none" entry */
  value: string | null;
  onChange: (value: string | null) => void;
  /** label for the null option — omit to require a real organization */
  noneLabel?: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
};

/**
 * Organization picker that searches server-side — the list is paged, so it stays
 * usable once there are more organizations than fit in a dropdown.
 */
export function OrganizationCombobox({
  value,
  onChange,
  noneLabel,
  placeholder = "Select an organization",
  className,
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");

  // ponytail: plain debounce, no library
  useEffect(() => {
    const t = setTimeout(() => setSearch(input), 250);
    return () => clearTimeout(t);
  }, [input]);

  const { data, isFetching } = useQuery({
    queryKey: ["organizations", "search", search],
    queryFn: () =>
      getOrganizationsPage({ page: 1, limit: PAGE_SIZE, search }),
    enabled: open,
  });

  const options = data?.data ?? [];
  const selectedInPage = options.find((o) => o.id === value);

  // the selected org may not be in the current search page — fetch its name once
  const { data: selectedOrg } = useQuery({
    queryKey: ["organizations", value],
    queryFn: () => getOrganization(value as string),
    enabled: !!value && !selectedInPage,
  });

  const selectedLabel = value
    ? selectedInPage?.name ?? selectedOrg?.name ?? "…"
    : noneLabel;

  const total = data?.pagination?.total ?? 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "w-full justify-between font-normal",
            !selectedLabel && "text-muted-foreground",
            className
          )}
        >
          <span className="truncate">{selectedLabel ?? placeholder}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0"
        align="start"
      >
        {/* server does the filtering, so cmdk must not filter again */}
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search organizations…"
            value={input}
            onValueChange={setInput}
          />
          <CommandList>
            {isFetching && options.length === 0 ? (
              <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Searching…
              </div>
            ) : (
              <CommandEmpty>No organizations found.</CommandEmpty>
            )}
            <CommandGroup>
              {noneLabel && (
                <CommandItem
                  value="__none__"
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === null ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {noneLabel}
                </CommandItem>
              )}
              {options.map((org) => (
                <CommandItem
                  key={org.id}
                  value={org.id}
                  onSelect={() => {
                    onChange(org.id);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === org.id ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="truncate">{org.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            {total > options.length && (
              <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                Showing {options.length} of {total} — keep typing to narrow.
              </p>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
