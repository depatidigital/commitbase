import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, GitBranch, Github, Gitlab, Lock, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { listGitRepositories, type GitRepositoryListing } from "@/lib/git";
import { t } from "@/lib/i18n";

export const REPOSITORY_URL = /^(https?:\/\/|git@|ssh:\/\/)[^\s'"]+$/;

type Props = {
  value: string;
  onChange: (url: string) => void;
  id?: string;
  /** Connect buttons under the list; none given, none shown */
  onConnect?: (provider: "github" | "gitlab") => void;
};

/**
 * One field: pick from the connected accounts' repositories, or paste any URL
 * into its search. Used by the add-app form and the change-repository dialog.
 */
export function RepositoryCombobox({ value, onChange, id, onConnect }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  // every repo the connected accounts can see — cmdk searches the list locally
  const listing = useQuery({
    queryKey: ["git", "repositories"],
    queryFn: listGitRepositories,
    // the backend answers from its own cache; five minutes keeps the picker instant across pages
    staleTime: 5 * 60_000,
  });
  const groups = useMemo(() => {
    const groups = new Map<string, { key: string; heading: string; repositories: GitRepositoryListing["repositories"] }>();
    for (const repo of listing.data?.repositories ?? []) {
      const group = groups.get(repo.accountId) ?? {
        key: repo.accountId,
        heading: `${repo.provider === "github" ? "GitHub" : "GitLab"} · ${repo.account}`,
        repositories: [],
      };
      group.repositories.push(repo);
      groups.set(repo.accountId, group);
    }
    return [...groups.values()];
  }, [listing.data]);
  // the chosen repository, when it came from the list — shown by name, not URL
  const picked = listing.data?.repositories.find((repo) => repo.cloneUrl === value);
  const pasted = REPOSITORY_URL.test(search.trim());
  const choose = (url: string) => {
    onChange(url);
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-9 w-full justify-between bg-card px-3 font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            {picked ? (
              picked.provider === "github" ? (
                <Github className="h-4 w-4 shrink-0" />
              ) : (
                <Gitlab className="h-4 w-4 shrink-0" />
              )
            ) : (
              <Search className="h-4 w-4 shrink-0 opacity-50" />
            )}
            <span className={`truncate ${value ? "" : "text-muted-foreground"}`}>
              {picked?.fullName || value || t("Select a repository or paste a URL")}
            </span>
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] max-w-[calc(100vw-2rem)] p-0" align="start">
        <Command>
          <CommandInput placeholder={t("Search your repositories, or paste a Git URL…")} value={search} onValueChange={setSearch} />
          <CommandList>
            {/* a pasted URL is always offered, whatever the list filter says */}
            {pasted && (
              <CommandGroup>
                <CommandItem forceMount value={`url:${search.trim()}`} onSelect={() => choose(search.trim())}>
                  <GitBranch className="mr-2 h-4 w-4 shrink-0" />
                  <span className="truncate">{t("Use this URL: {url}", { url: search.trim() })}</span>
                </CommandItem>
              </CommandGroup>
            )}
            {listing.isLoading ? (
              <p className="p-4 text-sm text-muted-foreground">{t("Loading repositories…")}</p>
            ) : (
              !pasted && (
                <CommandEmpty>
                  {listing.data?.accounts.length
                    ? t("No repositories found — paste the URL instead.")
                    : onConnect
                      ? t("No GitHub or GitLab account connected. Connect one below, or paste a public repository URL.")
                      : t("No GitHub or GitLab account connected. Paste the repository URL.")}
                </CommandEmpty>
              )
            )}
            {groups.map(({ key, heading, repositories }) => (
              <CommandGroup key={key} heading={heading}>
                {repositories.map((repo) => (
                  <CommandItem key={`${repo.accountId}:${repo.fullName}`} value={`${repo.fullName} ${repo.accountId}`} onSelect={() => choose(repo.cloneUrl)}>
                    <Check className={`mr-2 h-4 w-4 shrink-0 ${value === repo.cloneUrl ? "opacity-100" : "opacity-0"}`} />
                    <span className="flex-1 truncate">{repo.fullName}</span>
                    {repo.private && <Lock className="ml-2 h-3 w-3 shrink-0 text-muted-foreground" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
        {!!listing.data?.errors.length && <p className="border-t px-3 py-2 text-xs text-destructive">{listing.data.errors.join(" · ")}</p>}
        {onConnect && (
          <div className="flex flex-wrap gap-1 border-t p-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onConnect("github")}>
              <Github className="h-4 w-4 mr-2" />
              {t("Connect GitHub")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => onConnect("gitlab")}>
              <Gitlab className="h-4 w-4 mr-2" />
              {t("Connect GitLab")}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
