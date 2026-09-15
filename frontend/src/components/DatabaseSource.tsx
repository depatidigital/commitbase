import { ArrowLeftRight, Database as DatabaseIcon, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

/** `postgresql://user:pass@db.host:5432/shop?x` → `db.host:5432/shop` — never the credentials. Pure. */
export function databaseAddress(url: string): string {
  const rest = url.split("://")[1] ?? url;
  return rest.slice(rest.lastIndexOf("@") + 1).split(/[?#]/)[0] ?? "";
}

/**
 * DATABASE_URL's value, as what it is — one of the organization's databases
 * (by name), a URL of its own (its host and database, never the password), or
 * none yet. One button: every change is made in the database dialog (`onOpen`),
 * where it is chosen between ours — new or existing — and a custom URL.
 */
export function DatabaseValue({
  value,
  dbName,
  onOpen,
  disabled,
}: {
  value: string;
  /** set when the value is one of ours */
  dbName?: string | null;
  onOpen: () => void;
  disabled?: boolean;
}) {
  if (!value.trim()) {
    return (
      <Button type="button" variant="outline" size="sm" className="h-8 w-full justify-start border-dashed font-normal" disabled={disabled} onClick={onOpen}>
        <DatabaseIcon className="mr-2 h-3.5 w-3.5" />
        {t("Pick a database…")}
      </Button>
    );
  }
  const ours = !!dbName;
  const Icon = ours ? DatabaseIcon : Link2;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onOpen}
      title={t("Change database")}
      className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-muted/40 px-3 text-left text-xs transition-colors hover:border-primary/40 disabled:opacity-50"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 rounded bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
        {ours ? t("Larika") : t("Custom")}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono">{ours ? dbName : databaseAddress(value)}</span>
      <ArrowLeftRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}
