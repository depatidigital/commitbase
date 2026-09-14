import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

/**
 * An imported app's env: its .env on the server, as the last sync read it.
 * Read-only — the file is the truth and the next sync overwrites; values stay
 * hidden until asked for, they are the app's secrets.
 */
export function ServerEnv({ env, dir }: { env: Record<string, string>; dir?: string | null }) {
  const [shown, setShown] = useState(false);
  const entries = Object.entries(env);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {t("Read from the .env on the server{dir} at the last sync. Change it there, then sync again.", {
            dir: dir ? ` (${dir})` : "",
          })}
        </p>
        {entries.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => setShown((value) => !value)}>
            {shown ? <EyeOff className="mr-2 h-4 w-4" /> : <Eye className="mr-2 h-4 w-4" />}
            {shown ? t("Hide values") : t("Show values")}
          </Button>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("No .env found in the app's folder.")}</p>
      ) : (
        <div className="divide-y divide-border/60 overflow-x-auto rounded-md border border-border/60 font-mono text-xs">
          {entries.map(([key, value]) => (
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
