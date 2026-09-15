import { ArrowLeftRight, Database as DatabaseIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

export type DatabaseSourceMode = "ours" | "custom";

/**
 * Where an app's database variable (DATABASE_URL) gets its value: one of the
 * organization's databases, picked in the database dialog — or a URL of its
 * own, typed. Two buttons side by side, beside the value.
 */
export function DatabaseSourceSwitch({
  mode,
  onChange,
  disabled,
}: {
  mode: DatabaseSourceMode;
  onChange: (mode: DatabaseSourceMode) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex h-8 shrink-0 items-center rounded-md border border-input p-0.5 text-[11px]" role="group" aria-label={t("Database source")}>
      {(
        [
          ["ours", t("Larika database")],
          ["custom", t("Custom")],
        ] as const
      ).map(([option, label]) => (
        <button
          key={option}
          type="button"
          aria-pressed={mode === option}
          disabled={disabled}
          onClick={() => mode !== option && onChange(option)}
          className={`h-full rounded px-2 transition-colors ${
            mode === option ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * The value in "ours" mode: the database it is connected to, by name — its URL
 * carries the password, so it is never shown — with ⇄ to change it; or, none
 * yet (or a local one that cannot work on the server), a button to pick one.
 * `onPick` opens the database dialog, which creates or reuses one.
 */
export function DatabasePick({ dbName, onPick, disabled }: { dbName?: string | null; onPick: () => void; disabled?: boolean }) {
  if (dbName) {
    return (
      <div className="flex h-8 min-w-0 items-center gap-2 rounded-md border bg-muted/40 px-3 text-xs">
        <DatabaseIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono">{dbName}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto h-6 w-6 shrink-0"
          disabled={disabled}
          onClick={onPick}
          title={t("Change database")}
          aria-label={t("Change database")}
        >
          <ArrowLeftRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }
  return (
    <Button type="button" variant="outline" size="sm" className="h-8 w-full justify-start border-dashed font-normal" disabled={disabled} onClick={onPick}>
      <DatabaseIcon className="mr-2 h-3.5 w-3.5" />
      {t("Pick a database…")}
    </Button>
  );
}
