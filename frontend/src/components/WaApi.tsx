import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Play, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CodeExample } from "@/components/CodeExample";
import { codeExamples, getWaApiCatalog, type Endpoint } from "@/lib/waApiCatalog";
import { callWaApi, getWaNumber, type WaNumber } from "@/lib/waGateway";
import { t } from "@/lib/i18n";

const METHOD_COLOR: Record<Endpoint["method"], string> = {
  GET: "text-emerald-700 dark:text-emerald-400",
  POST: "text-blue-700 dark:text-blue-400",
  PATCH: "text-amber-700 dark:text-amber-400",
  DELETE: "text-red-700 dark:text-red-400",
};
const CARD = "rounded-lg border bg-card p-4 shadow-sm";
const json = (value: unknown) => JSON.stringify(value, null, 2);
// the playground can't delete or move a number — the Numbers tab does, keeping the panel in step
const blocked = (e: Endpoint) => e.id === "delete" || e.id === "move";

const useWaApiCatalog = () => useQuery({ queryKey: ["wa-api-catalog"], queryFn: getWaApiCatalog, staleTime: 10 * 60_000 });

/** `code` and **bold** in the catalog's descriptions. */
function Md({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part, i) =>
        part.startsWith("`") ? (
          <code key={i} className="rounded bg-muted px-1 font-mono text-[0.85em]">
            {part.slice(1, -1)}
          </code>
        ) : part.startsWith("**") ? (
          <b key={i}>{part.slice(2, -2)}</b>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

const Method = ({ method }: { method: Endpoint["method"] }) => <span className={`w-12 shrink-0 font-mono text-[11px] font-semibold ${METHOD_COLOR[method]}`}>{method}</span>;

function CatalogState({ children }: { children: (endpoints: Endpoint[]) => JSX.Element }) {
  const { data, error, isLoading } = useWaApiCatalog();
  if (isLoading) return <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />;
  if (error || !data) return <p className="text-sm text-destructive">{(error as Error)?.message}</p>;
  return children(data.endpoints);
}

/** A form field: label, the field, its hint — stacked (the playground column is narrow). */
function Row({ id, label, hint, error, children }: { id?: string; label: ReactNode; hint?: string; error?: boolean; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="break-all">
        {label}
      </Label>
      <div className="min-w-0 space-y-1">
        {children}
        {hint && <p className={`text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}>{hint}</p>}
      </div>
    </div>
  );
}

/** Right column, top: what the picked call does and takes. */
function EndpointDoc({ e }: { e: Endpoint }) {
  return (
    <div className="space-y-3">
      <h3 className="font-semibold">{e.title}</h3>
      <div className="break-all font-mono text-sm">
        <span className={`font-semibold ${METHOD_COLOR[e.method]}`}>{e.method}</span> {e.path}
      </div>
      <p className="text-sm text-muted-foreground">
        <Md text={e.desc} />
      </p>
      {e.params && e.params.length > 1 && (
        <table className="w-full text-xs">
          <tbody>
            {e.params
              .filter((p) => p.name !== "id")
              .map((p) => (
                <tr key={p.name} className="border-b last:border-0 [&>td]:py-1.5 [&>td]:pr-3 [&>td]:align-top">
                  <td className="whitespace-nowrap font-mono">
                    {p.name}
                    {p.required && <span className="text-destructive">*</span>}
                  </td>
                  <td className="whitespace-nowrap text-muted-foreground">
                    {p.in} · {p.type}
                  </td>
                  <td className="text-muted-foreground">
                    <Md text={p.desc} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Left column: every Client API call, grouped; picking one shows it on the right. */
function CatalogList({ endpoints, selected, onSelect }: { endpoints: Endpoint[]; selected: Endpoint; onSelect: (id: string) => void }) {
  return (
    <div className="space-y-4">
      {[...new Set(endpoints.map((e) => e.group))].map((group) => (
        <section key={group} className="space-y-1">
          <h3 className="px-2 text-xs font-medium uppercase text-muted-foreground">{group}</h3>
          {endpoints
            .filter((e) => e.group === group)
            .map((e) => (
              <button
                key={e.id}
                type="button"
                title={e.title}
                onClick={() => onSelect(e.id)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${e.id === selected.id ? "bg-primary/10 font-medium text-primary" : "hover:bg-muted/60"}`}
              >
                <Method method={e.method} />
                <span className="min-w-0 flex-1 truncate">{e.title}</span>
              </button>
            ))}
        </section>
      ))}
    </div>
  );
}

// ── Playground: the gateway dashboard's Playground, run through the panel ──

type Vars = { phone: string; chat: string; group: string; sendId: string; waMessageId: string };
const VARS_KEY = "larika-playground-vars";
const EMPTY: Vars = { phone: "", chat: "", group: "", sendId: "", waMessageId: "" };
function loadVars(): Vars {
  try {
    return { ...EMPTY, ...JSON.parse(localStorage.getItem(VARS_KEY) ?? "{}") };
  } catch {
    return EMPTY;
  }
}

/** Value of each variable. `chat` empty = the phone's own chat (0812… → 62812…@s.whatsapp.net). */
function values(v: Vars): Record<string, string> {
  const phone = v.phone.replace(/[\s+\-().]/g, "");
  const own = phone ? `${phone.startsWith("0") ? "62" + phone.slice(1) : phone}@s.whatsapp.net` : "";
  return { ...v, chat: v.chat || own };
}

/** {{name}} → its value (URL-encoded for paths). Unknown tags stay as they are. */
function fill(text: string, vals: Record<string, string>, encode = false) {
  return text.replace(/\{\{(\w+)\}\}/g, (tag, name: string) => (name in vals ? (encode ? encodeURIComponent(vals[name]) : vals[name]) : tag));
}

/** Variable fields, shown on a call only when it uses the tag. */
const VAR_FIELDS: Record<keyof Vars, { hint: () => string; placeholder: string }> = {
  phone: { hint: () => t("Target number: 0812…, +62 812… or 62812…"), placeholder: "628123456789" },
  chat: { hint: () => t("Chat JID or a plain number. Empty = the phone's chat"), placeholder: "62812…@s.whatsapp.net / …@g.us" },
  group: { hint: () => t("Group JID (Groups → List groups)"), placeholder: "120363…@g.us" },
  sendId: { hint: () => t("The id of a message you sent (fills itself after Send)"), placeholder: "cmui…" },
  waMessageId: { hint: () => t("WhatsApp's message id (fills itself from Chat messages)"), placeholder: "3EB0…" },
};

type Result = { ok: boolean; status?: number; ms: number; body: string };

/**
 * The API tab: the gateway's catalog on the left, and on the right a playground
 * that tries the picked call against a real number, then gives it as code. The
 * panel makes the call with the gateway's admin key, so no API key is pasted
 * here; the code uses the app's own key.
 */
export function ApiPlayground(props: { rows: WaNumber[]; gatewayUrl: string; onAdd?: () => void }) {
  const [endpointId, setEndpointId] = useState("send-text");
  return <CatalogState>{(endpoints) => <PlaygroundBody {...props} endpointId={endpointId} onEndpoint={setEndpointId} endpoints={endpoints} />}</CatalogState>;
}

function PlaygroundBody({
  rows,
  gatewayUrl,
  onAdd,
  endpointId,
  onEndpoint,
  endpoints,
}: {
  rows: WaNumber[];
  gatewayUrl: string;
  onAdd?: () => void;
  endpointId: string;
  onEndpoint: (id: string) => void;
  endpoints: Endpoint[];
}) {
  const numbers = rows.filter((r) => r.canManage);
  const [picked, setNumberId] = useState("");
  const numberId = numbers.some((r) => r.id === picked) ? picked : ((numbers.find((r) => r.status === "ONLINE") ?? numbers[0])?.id ?? "");
  const { data: number } = useQuery({ queryKey: ["wa-number", numberId], queryFn: () => getWaNumber(numberId), enabled: !!numberId, retry: false });
  const ep = endpoints.find((e) => e.id === endpointId) ?? endpoints[0];
  const [vars, setVars] = useState<Vars>(loadVars);
  const [query, setQuery] = useState<Record<string, string>>({});
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const setVar = (k: keyof Vars, value: string) =>
    setVars((v) => {
      const next = { ...v, [k]: value.trim() };
      try {
        localStorage.setItem(VARS_KEY, JSON.stringify(next));
      } catch {
        /* private mode: not remembered */
      }
      return next;
    });

  // switching call: its example params
  useEffect(() => {
    setQuery({ ...(ep?.query ?? {}) });
    setBody(ep?.body === undefined ? "" : json(ep.body));
    setResult(null);
    setArmed(false);
  }, [ep]);

  const vals = values(vars);
  const path = ep ? fill(ep.path.replace("/v1/instances/{id}", ""), vals, true) : "";
  const filledQuery = Object.fromEntries(Object.entries(query).map(([k, v]) => [k, fill(v, vals)]));
  const qs = new URLSearchParams(Object.entries(filledQuery).filter(([, v]) => v !== "")).toString();
  const filledBody = fill(body, vals);
  let bodyError: string | null = null;
  try {
    if (filledBody.trim()) JSON.parse(filledBody);
  } catch (e) {
    bodyError = (e as Error).message;
  }
  const url = `${gatewayUrl}/v1/instances/${number?.instanceId ?? "{id}"}${path}${qs ? `?${qs}` : ""}`;
  // tags this call uses whose variable is still empty
  const used = ep ? [...new Set([...(ep.path + JSON.stringify(query) + body).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].filter((n): n is keyof Vars => n in EMPTY) : [];
  const missing = used.filter((n) => !vals[n]);
  const canSend = !busy && !!numberId && !!ep && !blocked(ep) && !bodyError && missing.length === 0;

  async function send() {
    if (!ep) return;
    if (ep.danger && !armed) return setArmed(true);
    setArmed(false);
    setBusy(true);
    const started = performance.now();
    try {
      const r = await callWaApi(numberId, { method: ep.method, path, query: filledQuery, ...(filledBody.trim() && { body: JSON.parse(filledBody) }) });
      setResult({ ok: r.ok, status: r.status, ms: Math.round(performance.now() - started), body: json(r.response) });
      if (r.ok) capture(ep, r.response);
    } catch (e) {
      setResult({ ok: false, ms: Math.round(performance.now() - started), body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  /** Ids for the next call, from this response: Send → sendId, Chat messages → newest received waMessageId. */
  function capture(e: Endpoint, r: unknown) {
    if (e.method === "POST" && e.path.endsWith("/messages") && (r as { id?: string })?.id) setVar("sendId", (r as { id: string }).id);
    if (e.path.endsWith("/chats/{{chat}}/messages") && Array.isArray(r)) {
      const m = r.find((x) => !x.fromMe) ?? r[0];
      if (m?.waMessageId) setVar("waMessageId", m.waMessageId);
    }
  }

  // Ctrl+Enter (⌘+Enter) sends from anywhere on the tab
  const latest = useRef({ canSend, send });
  latest.current = { canSend, send };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || document.querySelector("[role=dialog]")) return;
      e.preventDefault();
      if (latest.current.canSend) void latest.current.send();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!ep) return null;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <nav className={`${CARD} p-2 lg:sticky lg:top-4 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto`}>
        <CatalogList endpoints={endpoints} selected={ep} onSelect={onEndpoint} />
      </nav>

      {/* explanation left; the same call as code, and tried for real, right */}
      <div className="grid min-w-0 items-start gap-4 xl:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <p className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-muted-foreground">
            {t("All calls go to")}{" "}
            <code className="font-mono text-foreground">
              {gatewayUrl || "…"}/v1/instances/{"{id}"}/…
            </code>{" "}
            {t("with the number's API key in")} <code className="font-mono text-foreground">Authorization: Bearer lwg_…</code>.
          </p>
          <div className={CARD}>
            <EndpointDoc e={ep} />
          </div>
          <div className={`${CARD} space-y-2`}>
            <Label>
              {t("Example response")} · HTTP {ep.response.status}
            </Label>
            <pre className="max-h-96 overflow-auto rounded-md bg-muted/60 p-3 font-mono text-xs">{json(ep.response.body)}</pre>
          </div>
        </div>

        <div className="min-w-0 space-y-4">
          <div className={`${CARD} space-y-2`}>
            <Row
              label={t("WA instance")}
              hint={numbers.length ? t("The Playground calls the API as this number; the code uses its URL.") : t("Add a number you manage first; the Playground calls the API as that number.")}
            >
              <div className="flex gap-2">
                <Select value={numberId} onValueChange={setNumberId} disabled={!numbers.length}>
                  <SelectTrigger className="min-w-0 flex-1">
                    <SelectValue placeholder={t("No numbers yet")} />
                  </SelectTrigger>
                  <SelectContent>
                    {numbers.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        <span className="flex items-center gap-2">
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${r.status === "ONLINE" ? "bg-success" : r.status === "QR" || r.status === "CONNECTING" ? "bg-warning" : "bg-destructive"}`}
                          />
                          {r.name}
                          {r.phone && <span className="font-mono text-xs text-muted-foreground">+{r.phone}</span>}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!numbers.length && onAdd && (
                  <Button variant="outline" onClick={onAdd} className="shrink-0">
                    <Plus className="mr-2 h-4 w-4" />
                    {t("Add number")}
                  </Button>
                )}
              </div>
            </Row>
          </div>
          <div className={`${CARD} space-y-3`}>
            <Label>{t("Code")}</Label>
            {!bodyError && <CodeExample examples={codeExamples(ep.method, url, filledBody.trim())} />}
            <p className="text-xs text-muted-foreground">{t("The code uses your app's API key (API & keys on the number); the Playground itself needs none.")}</p>
          </div>
          <div className={`${CARD} space-y-4`}>
            {blocked(ep) && <p className="text-sm text-warning">{t("Delete or move the number from the Numbers tab.")}</p>}
            {Object.keys(query).map((k) => (
              <Row key={k} id={`q-${k}`} label={<code>?{k}</code>} hint="query">
                <Input id={`q-${k}`} className="font-mono text-sm" value={query[k]} onChange={(e) => setQuery((q) => ({ ...q, [k]: e.target.value }))} />
              </Row>
            ))}
            {used.length > 0 && (
              <div className="space-y-3 rounded-md bg-primary/5 p-3 ring-1 ring-primary/15">
                {used.map((n) => (
                  <Row key={n} id={`var-${n}`} label={<code>{`{{${n}}}`}</code>} hint={`${VAR_FIELDS[n].hint()}${n === "chat" && !vars.chat && vals.chat ? ` (${vals.chat})` : ""}`}>
                    <Input id={`var-${n}`} className="bg-background font-mono text-sm" placeholder={VAR_FIELDS[n].placeholder} value={vars[n]} onChange={(e) => setVar(n, e.target.value)} />
                  </Row>
                ))}
                <p className="text-xs text-muted-foreground">{t("Variables are shared by every call and remembered in this browser.")}</p>
              </div>
            )}
            {ep.body !== undefined && (
              <div className="space-y-1">
                <Label htmlFor="pg-body">{t("Body (JSON)")}</Label>
                <Textarea id="pg-body" rows={Math.min(12, body.split("\n").length + 1)} spellCheck={false} className="font-mono text-sm" value={body} onChange={(e) => setBody(e.target.value)} />
                {bodyError && <p className="text-xs text-destructive">{bodyError}</p>}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant={ep.danger ? "destructive" : "default"} disabled={!canSend} onClick={() => void send()} title="Ctrl+Enter">
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                {armed ? t("Really send?") : t("Send")}
              </Button>
              <kbd className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground">Ctrl+Enter</kbd>
              {ep.danger && (
                <span className="flex items-center gap-1.5 text-xs text-warning">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {t("This changes the real number.")}
                </span>
              )}
            </div>
            {missing.length > 0 && <p className="text-sm text-warning">{t("Fill {vars} first.", { vars: missing.map((n) => `{{${n}}}`).join(", ") })}</p>}
          </div>
          {result && (
            <div className={`${CARD} space-y-2`}>
              <div className="flex items-center gap-3 text-sm">
                <span className={`font-semibold ${result.ok ? "text-success" : "text-destructive"}`}>{result.ok ? "OK" : result.status ? `HTTP ${result.status}` : t("Error")}</span>
                <span className="text-muted-foreground">{result.ms} ms</span>
              </div>
              <pre className="max-h-[50vh] overflow-auto rounded-md bg-muted/60 p-3 font-mono text-xs">{result.body}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
