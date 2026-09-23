import { useMemo, useRef, useState } from "react";
import { PopoverClose } from "@radix-ui/react-popover";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AlertTriangle, Check, CheckCircle2, ChevronsUpDown, ClipboardPaste, Database as DatabaseIcon, Eye, EyeOff, FileCode2, Info, FileUp, Loader2, PlugZap, Plus, Sparkles, Trash2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DataTable, useTableQuery, type Column } from "@/components/DataTable";
import { ENV_NAME, PLATFORM_KEYS, isSecret, mergeRows, parseEnv, pointsAtLocalhost, type EnvRow } from "@/lib/env";
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
  /** shown instead of the value field when not null, e.g. a database the panel manages, by name */
  renderValue?: (row: EnvRow) => React.ReactNode;
  /** a better value for a row, offered as a one-click fix (the app's own URL for NEXT_PUBLIC_BASE_URL) */
  suggest?: (row: EnvRow) => string | null;
  /** a freshly generated value for a row (a secret the app mints itself), offered as "Generate" */
  generate?: (row: EnvRow) => string | null;
  /**
   * A real check for a row (a database URL tried from the app's node), or
   * null when the row has none. Such a row gets "Test connection" instead of
   * the guess from the text that a localhost address cannot work.
   */
  verify?: (row: EnvRow) => (() => Promise<{ ok: boolean; message: string }>) | null;
  /** addresses offered on *_URL / *_URI / *_ORIGIN rows (the project's hosts) — picked or typed over */
  urlOptions?: string[];
  /**
   * Rows shown as one: its members (POSTGRES_HOST, _PORT, _PASSWORD…) folded into a
   * read-only name, the value what the caller renders (a database picker); its bin removes them all.
   */
  group?: { keys: string[]; label: string; value: React.ReactNode } | null;
  disabled?: boolean;
}

type Indexed = { row: EnvRow; index: number };

// one line by nature — an address, a name, an id, a switch: an input. Anything
// else may run long or span lines (a key, a JSON blob, a list): a growing textarea.
const SHORT_NAME = /(^|_)(URL|URI|HOST|HOSTNAME|PORT|NAME|ID|ORIGIN|DOMAIN|EMAIL|USER|USERNAME|REGION|BUCKET|ENDPOINT|PATH|DIR|ENV|MODE|LEVEL|VERSION|TIMEOUT|TTL|ENABLED|DEBUG)$/i;
const oneLine = (row: EnvRow) => SHORT_NAME.test(row.key) || /^(true|false|\d+)$/i.test(row.value.trim());
// an address the app is given: where the project's hosts are offered
const URL_NAME = /(^|_)(URL|URI|ORIGIN)$/i;
// …unless it is a connection string, not a web address
const CONNECTION_NAME = /(DATABASE|DB|POSTGRES|MYSQL|MONGO|REDIS|AMQP|RABBIT|KAFKA|SMTP|MAIL)/i;

/**
 * Env vars as a table: searched by name, narrowed to the ones that need a look,
 * scrolled under a sticky header. Values are masked until revealed. Pasting a
 * whole .env into any name field splits it into rows, which is how most people
 * arrive with their variables.
 */
export function EnvEditor({ rows, onChange, required, locked, hints, renderAction, renderValue, suggest, generate, verify, urlOptions = [], group, disabled }: EnvEditorProps) {
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [pasting, setPasting] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  // test outcomes by name+value, so editing the value drops a stale one
  const [checks, setChecks] = useState<Record<string, "pending" | { ok: boolean; message: string }>>({});
  // the rows the table shows: all, or only those that need a look
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  // ponytail: 100 a page — past that the table pages; an app with more env is rare
  const query = useTableQuery(100);
  const list = rows.length > 0 ? rows : [{ key: "", value: "" }];

  const runCheck = async (row: EnvRow, check: () => Promise<{ ok: boolean; message: string }>) => {
    const id = `${row.key} ${row.value}`;
    setChecks((prev) => ({ ...prev, [id]: "pending" }));
    const outcome = await check().catch((error: Error) => ({ ok: false, message: error.message }));
    setChecks((prev) => ({ ...prev, [id]: outcome }));
  };

  // a .env that would change values already set: held until the user says add-only or overwrite
  const [conflict, setConflict] = useState<{ base: EnvRow[]; imported: EnvRow[]; changed: string[] } | null>(null);

  const finish = (base: EnvRow[], incoming: EnvRow[], skipped = 0) => {
    onChange(mergeRows(base, incoming, true));
    setNotice(
      skipped
        ? t("{count} variables imported, {skipped} kept as they were — review, then save.", { count: incoming.length, skipped })
        : t("{count} variables imported — review, then save.", { count: incoming.length }),
    );
  };

  /**
   * Never removes a variable. New names are added and empty ones filled; a
   * name that already has a different value is only overwritten after asking —
   * a stale .env pasted over live secrets is the mistake this guards.
   */
  const applyImport = (base: EnvRow[], imported: EnvRow[]) => {
    const changed = imported
      .filter((row) => {
        const existing = base.find((current) => current.key === row.key);
        return !!existing?.value && existing.value !== row.value;
      })
      .map((row) => row.key);
    if (changed.length) setConflict({ base, imported, changed });
    else finish(base, imported);
  };

  const importText = (text: string) => {
    const imported = parseEnv(text);
    if (imported.length === 0) setNotice(t("No KEY=value lines found."));
    else applyImport(list, imported);
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
    applyImport(without, pasted);
  };

  const toggle = (index: number) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  // what a row needs said about it — shared by its cells and the filter
  const view = (row: EnvRow, index: number) => {
    const secret = isSecret(row.key);
    const check = row.value.trim() ? verify?.(row) ?? null : null;
    return {
      invalid: row.key.trim() !== "" && !ENV_NAME.test(row.key.trim()),
      missing: !!required?.has(row.key) && !row.value,
      // only secrets are masked (and get the eye); a URL or a port is plain text
      secret,
      shown: !secret || revealed.has(index),
      multiline: row.value.includes("\n"),
      fixed: !!locked?.has(row.key),
      check,
      checked: checks[`${row.key} ${row.value}`],
      // a row that can be tried for real is not judged by its text
      local: !check && pointsAtLocalhost(row.value),
      suggestion: suggest?.(row) ?? null,
      // whether it can be generated — the value itself is made on click, fresh
      generatable: !!generate?.(row),
      // Larika's own at runtime always says so; one it only defaults (NODE_ENV) once a value replaces it
      platform: PLATFORM_KEYS[row.key] === "ignored" || row.value.trim() ? PLATFORM_KEYS[row.key] : undefined,
      customValue: renderValue?.(row) ?? null,
    };
  };

  // The names the code expects first (they want a value), then by name, so one
  // prefix sits together (POSTGRES_*, CKAN_SYSADMIN_*); a row still unnamed last. Re-sorted when rows come or go, not per keystroke: a row being
  // renamed does not jump away under the cursor.
  const order = useMemo(
    () =>
      list
        .map((row, index) => ({ key: row.key, index }))
        .sort(
          (a, b) =>
            Number(!!locked?.has(b.key)) - Number(!!locked?.has(a.key)) ||
            (!a.key ? 1 : !b.key ? -1 : a.key.localeCompare(b.key)) ||
            a.index - b.index,
        )
        .map(({ index }) => index),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list.length, locked],
  );
  const grouped = new Set(group?.keys ?? []);
  // the group shows as its first member; the others are behind it
  const groupAt = order.find((index) => index < list.length && grouped.has(list[index]!.key));
  const inGroup = (index: number) => grouped.has(list[index]?.key ?? '');
  const indexed: Indexed[] = order
    .filter((index) => index < list.length && (!inGroup(index) || index === groupAt))
    .map((index) => ({ row: list[index]!, index }));
  // needs a look: expected but empty, a name that cannot be exported, an address that cannot work on the server
  const isFlagged = ({ row, index }: Indexed) => {
    const v = view(row, index);
    return v.missing || v.invalid || v.local;
  };
  const flaggedCount = indexed.filter(isFlagged).length;
  const tableRows = onlyFlagged ? indexed.filter(isFlagged) : indexed;

  const nameCell = ({ row, index }: Indexed) => {
    if (group && index === groupAt) {
      // text, not a field: nothing to type — its members are set together, from the value
      return (
        <p className="flex min-h-8 items-start gap-1.5 py-1.5 font-mono text-xs" title={group.keys.join(", ")}>
          <DatabaseIcon className="mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="break-all">{group.label}</span>
        </p>
      );
    }
    const { invalid, missing, fixed } = view(row, index);
    const hint = hints?.[row.key];
    // a name the code expects: text with a mark, not a field that cannot be typed in
    if (fixed && !invalid) {
      return (
        <p className="flex min-h-8 items-start gap-1.5 py-1.5 font-mono text-xs" title={hint ? `${t("The code expects this name")} — ${hint}` : t("The code expects this name")}>
          <FileCode2 className="mt-px h-3 w-3 shrink-0 text-primary" />
          <span className="break-all">{row.key}</span>
        </p>
      );
    }
    return (
      <div className="space-y-1">
        <div className="relative">
          <Input
            {...NO_AUTOFILL}
            name={`env-name-${index}`}
            aria-label={t("Name")}
            placeholder="DATABASE_URL"
            className={`h-8 font-mono text-xs ${hint ? "pr-7" : ""} ${invalid ? "border-destructive" : ""} ${fixed ? "bg-muted/50 text-muted-foreground" : ""}`}
            value={row.key}
            readOnly={fixed}
            title={fixed ? t("The code expects this name") : undefined}
            disabled={disabled}
            onChange={(e) => update(index, { key: e.target.value.replace(/\s/g, "") })}
            onPaste={(e) => pasteInto(index, e)}
          />
          {/* where it came from (.env.example…): a mark in the field, the words on hover — not a line of its own */}
          {hint && (
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" title={hint} aria-label={hint}>
              <Info className="h-3.5 w-3.5" />
            </span>
          )}
        </div>
        {/* only what needs doing gets a line */}
        {(missing || invalid) && (
          <p className="text-[11px] text-destructive">
            {invalid ? t("Letters, digits and _ only; not starting with a digit") : t("Needs a value — or remove it if unused")}
          </p>
        )}
      </div>
    );
  };

  const valueCell = ({ row, index }: Indexed) => {
    if (group && index === groupAt) return group.value;
    const { missing, secret, shown, multiline, check, checked, local, suggestion, generatable, platform, customValue } = view(row, index);
    const action = renderAction?.(row);
    const invalidValue = missing || (checked && checked !== "pending" && !checked.ok);
    return (
      <div className="space-y-1">
        <div className="flex min-w-0 items-start gap-2">
        <div className="relative min-w-0 flex-1">
        {/* a secret's show/hide, inside its box */}
        {secret && !customValue && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-0.5 top-0.5 z-10 h-7 w-7 text-muted-foreground"
            title={shown ? t("Hide") : t("Show")}
            aria-label={shown ? t("Hide") : t("Show")}
            onClick={() => toggle(index)}
          >
            {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </Button>
        )}
        {customValue ? (
          customValue
        ) : PLATFORM_KEYS[row.key] === "ignored" ? (
          // Larika's own at runtime (the port the proxy dials): not the app's to set — shown as what it becomes
          <Input
            aria-label={t("Value")}
            className="h-8 cursor-default bg-muted/50 font-mono text-xs text-muted-foreground"
            value={`{${row.key}}`}
            readOnly
            tabIndex={-1}
            title={t("Set by Larika when the service starts.")}
          />
        ) : shown && (multiline || (!secret && !oneLine(row))) ? (
          // grows with what is in it (field-sizing), a line at first — a masked secret stays an input
          <Textarea
            aria-label={t("Value")}
            className={`max-h-40 min-h-8 resize-y py-1.5 font-mono text-xs [field-sizing:content] ${secret ? "pr-9" : ""} ${
              invalidValue ? "border-destructive" : local ? "border-amber-500" : ""
            }`}
            rows={1}
            placeholder={missing ? t("required") : t("value")}
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
            className={`h-8 font-mono text-xs ${secret ? "pr-9" : ""} ${invalidValue ? "border-destructive" : local ? "border-amber-500" : ""}`}
            placeholder={missing ? t("required") : t("value")}
            value={multiline && !shown ? "••••••" : row.value}
            readOnly={multiline && !shown}
            disabled={disabled}
            onChange={(e) => update(index, { value: e.target.value })}
          />
        )}
        </div>
        {/* suggestions, all of them whatever is typed (a datalist filters by the value): the row's own
            suggestion first, then the project's hosts — each alone and under its path. Picked, or typed over */}
        {/* not where the row has a picker of its own (DATABASE_URL's database), nor on a connection
            string — a database, a cache or a queue is never one of the project's web hosts */}
        {!customValue && !action && !secret && !CONNECTION_NAME.test(row.key) && (urlOptions.length > 0 || suggestion) && URL_NAME.test(row.key) && (
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" size="icon" className="h-8 w-8 shrink-0" title={t("Suggestions")} disabled={disabled}>
                <ChevronsUpDown className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto min-w-[16rem] p-1">
              <p className="px-2 py-1 text-[11px] text-muted-foreground">{t("Suggestions")}</p>
              {[...new Set([...(suggestion ? [suggestion] : []), ...urlOptions])].map((url) => (
                <PopoverClose asChild key={url}>
                  <button
                    type="button"
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-xs hover:bg-muted ${row.value === url ? "text-primary" : ""}`}
                    onClick={() => update(index, { value: url })}
                  >
                    <Check className={`h-3 w-3 shrink-0 ${row.value === url ? "opacity-100" : "opacity-0"}`} />
                    {url}
                  </button>
                </PopoverClose>
              ))}
            </PopoverContent>
          </Popover>
        )}
        {/* the row's own control (the database dialog on DATABASE_URL) sits by the value it sets */}
        {action}
        </div>
        {/* said even when masked — the host is the part that matters here */}
        {(local || suggestion || generatable || platform || check) && (
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
            {check && (
              <>
                <button
                  type="button"
                  className="flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50"
                  disabled={disabled || checked === "pending"}
                  onClick={() => runCheck(row, check)}
                >
                  {checked === "pending" ? <Loader2 className="h-3 w-3 animate-spin" /> : <PlugZap className="h-3 w-3" />}
                  {t("Test connection")}
                </button>
                {checked && checked !== "pending" && (
                  <span className={`flex min-w-0 items-center gap-1 break-all ${checked.ok ? "text-green-600 dark:text-green-400" : "text-destructive"}`}>
                    {checked.ok ? <CheckCircle2 className="h-3 w-3 shrink-0" /> : <XCircle className="h-3 w-3 shrink-0" />}
                    {checked.message}
                  </span>
                )}
              </>
            )}
            {platform && (
              <span className="text-muted-foreground">
                {platform === "ignored" ? t("Set by Larika when the service starts.") : t("Larika already sets this to production; this value replaces it.")}
              </span>
            )}
            {generatable && (
              <button
                type="button"
                className="flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50"
                disabled={disabled}
                onClick={() => {
                  const value = generate?.(row);
                  if (value) update(index, { value });
                }}
              >
                <Sparkles className="h-3 w-3" />
                {t("Generate")}
              </button>
            )}
            {local && (
              <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                {row.key === "DATABASE_URL" ? t("Local address, won't work on the server. Use Connect database.") : t("Local address, won't work on the server.")}
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
    );
  };

  const actionCell = ({ row, index }: Indexed) => {
    if (group && index === groupAt) {
      return (
        <div className="flex items-center justify-end">
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title={t("Remove")} disabled={disabled} onClick={() => onChange(list.filter((row) => !grouped.has(row.key)))}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-end gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          // an expected key the app does not use goes too — .env.example lists more than every setup needs
          title={t("Remove")}
          disabled={disabled}
          onClick={() => onChange(list.filter((_, i) => i !== index))}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    );
  };

  const columns: Column<Indexed>[] = [
    { header: "#", className: "w-10 align-top pt-4 text-xs text-muted-foreground", cell: ({ index }) => indexed.findIndex((entry) => entry.index === index) + 1 },
    { header: t("Name"), className: "w-[38%] align-top", cell: nameCell },
    { header: t("Value"), className: "align-top", cell: valueCell },
    // the bin (a secret's eye is in its value box)
    { header: "", className: "w-12 align-top", cell: actionCell },
  ];

  return (
    // a flex column: in a dialog the table takes the height left and scrolls alone, not the dialog
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <DataTable
        className="min-h-[12rem] flex-1"
        // every row is on screen (it scrolls): a count under them says nothing
        showCount={false}
        // nor a page size: the toolbar and search on one line
        sizePicker={false}
        columns={columns}
        rows={tableRows}
        rowKey={({ index }) => String(index)}
        query={query}
        filter={({ row }, search) => row.key.toLowerCase().includes(search.toLowerCase())}
        searchPlaceholder={t("Search variables…")}
        // capped on a page; in a dialog it also shrinks to the room left, so only it scrolls
        bodyClassName="min-h-0 flex-1 max-h-[55vh]"
        empty={onlyFlagged ? t("Nothing needs a look.") : t("No results.")}
        toolbar={
          <>
            {(flaggedCount > 0 || onlyFlagged) && (
              <Button
                type="button"
                variant={onlyFlagged ? "secondary" : "outline"}
                size="sm"
                aria-pressed={onlyFlagged}
                className={onlyFlagged ? "" : "text-amber-600 dark:text-amber-400"}
                onClick={() => setOnlyFlagged((on) => !on)}
              >
                <AlertTriangle className="mr-1.5 h-3.5 w-3.5" />
                {t("Needs a look ({count})", { count: flaggedCount })}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => {
                // a new row at the end: shown whatever the filter was
                setOnlyFlagged(false);
                query.setInput("");
                onChange([...list, { key: "", value: "" }]);
              }}
            >
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
          </>
        }
      />
      {notice && <p className="text-xs text-muted-foreground">{notice}</p>}

      <Dialog open={pasting !== null} onOpenChange={(open) => !open && setPasting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Paste .env")}</DialogTitle>
            <DialogDescription>
              {t("Every KEY=value line becomes a variable. Nothing is removed; if a name already has a different value, you choose whether to overwrite it.")}
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

      <Dialog open={!!conflict} onOpenChange={(open) => !open && setConflict(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Some variables already have a value")}</DialogTitle>
            <DialogDescription>
              {t("The .env has a different value for {count} of them. Add only what is new, or overwrite these too?", {
                count: conflict?.changed.length ?? 0,
              })}
            </DialogDescription>
          </DialogHeader>
          {/* names only — the values are often secrets */}
          <div className="flex max-h-40 flex-wrap gap-1.5 overflow-auto">
            {conflict?.changed.map((key) => (
              <code key={key} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                {key}
              </code>
            ))}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="ghost" onClick={() => setConflict(null)}>
              {t("Cancel")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                if (conflict) finish(conflict.base, conflict.imported);
                setConflict(null);
              }}
            >
              {t("Overwrite {count}", { count: conflict?.changed.length ?? 0 })}
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (conflict) {
                  const fresh = conflict.imported.filter((row) => !conflict.changed.includes(row.key));
                  finish(conflict.base, fresh, conflict.changed.length);
                }
                setConflict(null);
              }}
            >
              {t("Add new only")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
