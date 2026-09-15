import { useState } from "react";
import { Eye, EyeOff, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";

/**
 * An imported app's env: its .env on the server, as the last sync read it.
 * Read-only — the file is the truth and the next sync overwrites; values stay
 * hidden until asked for, they are the app's secrets.
 */
export function ServerEnv({ env, dir, note }: { env: Record<string, string>; dir?: string | null; /** instead of the .env-on-the-server line (the panel's own apps) */ note?: React.ReactNode }) {
  const [shown, setShown] = useState(false);
  const [query, setQuery] = useState("");
  const entries = Object.entries(env);
  // by name — and by value once the values are shown, never matching on a hidden secret
  const needle = query.trim().toLowerCase();
  const matching = needle
    ? entries.filter(([key, value]) => key.toLowerCase().includes(needle) || (shown && value.toLowerCase().includes(needle)))
    : entries;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {note ??
          t("Read from the .env on the server{dir} at the last sync. Change it there, then sync again.", {
            dir: dir ? ` (${dir})` : "",
          })}
      </p>
      {entries.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="h-9 pl-8 font-mono text-xs" value={query} placeholder={t("Filter variables…")} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <Button variant="outline" size="sm" onClick={() => setShown((value) => !value)}>
            {shown ? <EyeOff className="mr-2 h-4 w-4" /> : <Eye className="mr-2 h-4 w-4" />}
            {shown ? t("Hide values") : t("Show values")}
          </Button>
        </div>
      )}
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{note ? t("No environment variables configured") : t("No .env found in the app's folder.")}</p>
      ) : matching.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("No variable matches “{query}”.", { query: query.trim() })}</p>
      ) : (
        // a long .env scrolls in its own box
        <div className="max-h-80 divide-y divide-border/60 overflow-auto rounded-md border border-border/60 font-mono text-xs">
          {matching.map(([key, value]) => (
            <div key={key} className="grid grid-cols-[minmax(8rem,16rem)_1fr] gap-3 px-3 py-1.5">
              <span className="truncate font-medium" title={key}>
                {key}
              </span>
              <span className="break-all text-muted-foreground">{shown ? value || "—" : value ? "••••••••" : "—"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
