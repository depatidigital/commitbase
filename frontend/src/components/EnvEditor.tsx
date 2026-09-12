import { useState } from "react";
import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ENV_NAME, mergeRows, parseEnv, type EnvRow } from "@/lib/env";
import { t } from "@/lib/i18n";

interface EnvEditorProps {
  rows: EnvRow[];
  onChange: (rows: EnvRow[]) => void;
  /** keys the code expects that still have no value — flagged until filled */
  required?: Set<string>;
  /** a note under a key, e.g. where it came from */
  hints?: Record<string, string>;
  disabled?: boolean;
}

/**
 * Env vars as rows. Values are masked until revealed. Pasting a whole .env
 * into any name field splits it into rows, which is how most people arrive
 * with their variables.
 */
export function EnvEditor({ rows, onChange, required, hints, disabled }: EnvEditorProps) {
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const list = rows.length > 0 ? rows : [{ key: "", value: "" }];

  const update = (index: number, patch: Partial<EnvRow>) =>
    onChange(list.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const pasteInto = (index: number, event: React.ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    // one plain name is an ordinary paste; anything with "=" or several lines is a .env
    if (!/[=\n]/.test(text)) return;
    const pasted = parseEnv(text);
    if (pasted.length === 0) return;
    event.preventDefault();
    const without = list.filter((row, i) => i !== index || row.key.trim() || row.value);
    onChange(mergeRows(without, pasted, true));
  };

  const toggle = (index: number) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  return (
    <div className="space-y-2">
      {list.map((row, index) => {
        const invalid = row.key.trim() !== "" && !ENV_NAME.test(row.key.trim());
        const missing = !!required?.has(row.key) && !row.value;
        const shown = revealed.has(index);
        const multiline = row.value.includes("\n");
        return (
          <div key={index} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-start gap-2">
            <div className="space-y-1">
              <Input
                aria-label={t("Name")}
                placeholder="DATABASE_URL"
                className={`font-mono text-xs ${invalid ? "border-destructive" : ""}`}
                value={row.key}
                disabled={disabled}
                onChange={(e) => update(index, { key: e.target.value.replace(/\s/g, "") })}
                onPaste={(e) => pasteInto(index, e)}
              />
              {(hints?.[row.key] || missing || invalid) && (
                <p className={`text-[11px] ${missing || invalid ? "text-destructive" : "text-muted-foreground"}`}>
                  {invalid
                    ? t("Letters, digits and _ only; not starting with a digit")
                    : missing
                      ? t("Needs a value")
                      : hints?.[row.key]}
                </p>
              )}
            </div>
            {multiline && shown ? (
              <Textarea
                aria-label={t("Value")}
                className="font-mono text-xs"
                rows={3}
                value={row.value}
                disabled={disabled}
                onChange={(e) => update(index, { value: e.target.value })}
              />
            ) : (
              <Input
                aria-label={t("Value")}
                // masked like a password, but not one the browser should offer to save
                type={shown ? "text" : "password"}
                autoComplete="off"
                data-1p-ignore
                className={`font-mono text-xs ${missing ? "border-destructive" : ""}`}
                placeholder={missing ? t("required") : t("value")}
                value={multiline && !shown ? "••••••" : row.value}
                readOnly={multiline && !shown}
                disabled={disabled}
                onChange={(e) => update(index, { value: e.target.value })}
              />
            )}
            <div className="flex">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title={shown ? t("Hide") : t("Show")}
                onClick={() => toggle(index)}
              >
                {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title={t("Remove")}
                disabled={disabled}
                onClick={() => onChange(list.filter((_, i) => i !== index))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange([...list, { key: "", value: "" }])}>
          <Plus className="h-4 w-4 mr-2" />
          {t("Add variable")}
        </Button>
        <span className="text-xs text-muted-foreground">{t("Tip: paste a whole .env file into any name field.")}</span>
      </div>
    </div>
  );
}
