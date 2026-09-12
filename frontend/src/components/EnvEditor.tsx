import { useRef, useState } from "react";
import { AlertTriangle, ClipboardPaste, Eye, EyeOff, FileUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ENV_NAME, isSecret, mergeRows, parseEnv, pointsAtLocalhost, type EnvRow } from "@/lib/env";
import { t } from "@/lib/i18n";

/**
 * Mask values with CSS, not type=password: a text field next to a password
 * field is a login form to every password manager, which then fills a saved
 * admin email into the name and its password into the value. Without the CSS
 * (older Firefox) fall back to a password field the browser won't autofill.
 */
const CSS_MASK = typeof CSS !== "undefined" && !!CSS.supports?.("-webkit-text-security", "disc");
// password managers that ignore autocomplete=off honour these
const NO_AUTOFILL = { autoComplete: "off", "data-1p-ignore": true, "data-lpignore": "true", "data-bwignore": true, "data-form-type": "other", spellCheck: false };

interface EnvEditorProps {
  rows: EnvRow[];
  onChange: (rows: EnvRow[]) => void;
  /** keys the code expects that still have no value — flagged until filled */
  required?: Set<string>;
  /** names the code expects: renaming one would leave the app without it, so only the value is editable */
  locked?: Set<string>;
  /** a note under a key, e.g. where it came from */
  hints?: Record<string, string>;
  /** an extra control on a row, e.g. "Connect database" on DATABASE_URL */
  renderAction?: (row: EnvRow) => React.ReactNode;
  /** a better value for a row, offered as a one-click fix (the app's own URL for NEXT_PUBLIC_BASE_URL) */
  suggest?: (row: EnvRow) => string | null;
  disabled?: boolean;
}

/**
 * Env vars as rows. Values are masked until revealed. Pasting a whole .env
 * into any name field splits it into rows, which is how most people arrive
 * with their variables.
 */
export function EnvEditor({ rows, onChange, required, locked, hints, renderAction, suggest, disabled }: EnvEditorProps) {
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [pasting, setPasting] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const list = rows.length > 0 ? rows : [{ key: "", value: "" }];

  /** a .env from a file or the paste box: its values win over what is there — it is what the user just chose */
  const importText = (text: string) => {
    const imported = parseEnv(text);
    setNotice(
      imported.length > 0
        ? t("{count} variables imported — review, then save.", { count: imported.length })
        : t("No KEY=value lines found."),
    );
    if (imported.length > 0) onChange(mergeRows(list, imported, true));
  };

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
      {/* one grid for every row, so a row with an extra button keeps the same column widths */}
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-start gap-2">
      {list.map((row, index) => {
        const invalid = row.key.trim() !== "" && !ENV_NAME.test(row.key.trim());
        const missing = !!required?.has(row.key) && !row.value;
        // only secrets are masked (and get the eye); a URL or a port is plain text
        const secret = isSecret(row.key);
        const shown = !secret || revealed.has(index);
        const multiline = row.value.includes("\n");
        const fixed = !!locked?.has(row.key);
        const local = pointsAtLocalhost(row.value);
        const suggestion = suggest?.(row) ?? null;
        return (
          <div key={index} className="contents">
            <div className="space-y-1">
              <Input
                {...NO_AUTOFILL}
                name={`env-name-${index}`}
                aria-label={t("Name")}
                placeholder="DATABASE_URL"
                className={`font-mono text-xs ${invalid ? "border-destructive" : ""} ${fixed ? "bg-muted/50 text-muted-foreground" : ""}`}
                value={row.key}
                readOnly={fixed}
                title={fixed ? t("The code expects this name") : undefined}
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
            <div className="space-y-1">
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
                {...NO_AUTOFILL}
                name={`env-value-${index}`}
                aria-label={t("Value")}
                type={shown || CSS_MASK ? "text" : "password"}
                autoComplete={shown || CSS_MASK ? "off" : "new-password"}
                style={!shown && CSS_MASK ? ({ WebkitTextSecurity: "disc" } as React.CSSProperties) : undefined}
                className={`font-mono text-xs ${missing ? "border-destructive" : local ? "border-amber-500" : ""}`}
                placeholder={missing ? t("required") : t("value")}
                value={multiline && !shown ? "••••••" : row.value}
                readOnly={multiline && !shown}
                disabled={disabled}
                onChange={(e) => update(index, { value: e.target.value })}
              />
            )}
            {/* said even when masked — the host is the part that matters here */}
            {(local || suggestion) && (
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
                {local && (
                  <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    {row.key === "DATABASE_URL"
                      ? t("Local address, won't work on the server. Use Connect database.")
                      : t("Local address, won't work on the server.")}
                  </span>
                )}
                {suggestion && (
                  <button
                    type="button"
                    className="font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50"
                    disabled={disabled}
                    onClick={() => update(index, { value: suggestion })}
                  >
                    {t("Use {url}", { url: suggestion })}
                  </button>
                )}
              </p>
            )}
            </div>
            <div className="flex items-center gap-1">
              {renderAction?.(row)}
              {secret ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  title={shown ? t("Hide") : t("Show")}
                  onClick={() => toggle(index)}
                >
                  {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              ) : (
                // keeps the delete buttons in one column
                <span className="w-10" aria-hidden />
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                // an expected key would only come back — clear its value instead
                title={fixed ? t("The code expects this variable") : t("Remove")}
                disabled={disabled || fixed}
                onClick={() => onChange(list.filter((_, i) => i !== index))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        );
      })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange([...list, { key: "", value: "" }])}>
          <Plus className="h-4 w-4 mr-2" />
          {t("Add variable")}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => fileRef.current?.click()}>
          <FileUp className="h-4 w-4 mr-2" />
          {t("Upload .env")}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setPasting("")}>
          <ClipboardPaste className="h-4 w-4 mr-2" />
          {t("Paste .env")}
        </Button>
        {/* no accept filter: ".env" has no extension a picker would match */}
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = ""; // the same file again is a new pick
            if (file) importText(await file.slice(0, 256 * 1024).text());
          }}
        />
        {notice && <span className="text-xs text-muted-foreground">{notice}</span>}
      </div>

      <Dialog open={pasting !== null} onOpenChange={(open) => !open && setPasting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Paste .env")}</DialogTitle>
            <DialogDescription>
              {t("Every KEY=value line becomes a variable. Existing names get the pasted value; review before saving.")}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            {...NO_AUTOFILL}
            className="font-mono text-xs"
            rows={10}
            placeholder={"DATABASE_URL=postgres://…\nBETTER_AUTH_SECRET=…"}
            value={pasting ?? ""}
            onChange={(e) => setPasting(e.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPasting(null)}>
              {t("Cancel")}
            </Button>
            <Button
              type="button"
              disabled={!pasting?.trim()}
              onClick={() => {
                importText(pasting ?? "");
                setPasting(null);
              }}
            >
              {t("Import")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
