import { useEffect, useRef, useState } from "react";
import { KeyRound, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { CodeExample } from "@/components/CodeExample";
import { CatalogList, EndpointDoc, Md, Row } from "@/components/WaApi";
import { aiCodeExamples, callAiApi, useAiApiCatalog, withVars, type Catalog, type Endpoint } from "@/lib/aiApiCatalog";
import { t } from "@/lib/i18n";

// ponytail: sessionStorage — the key outlives a tab switch, not the browser session
const KEY_STORE = "larika-ai-playground-key";
const loadKey = () => {
  try {
    return sessionStorage.getItem(KEY_STORE) ?? "";
  } catch {
    return "";
  }
};

type Result = { ok: boolean; status?: number; ms: number; model?: string | null; body: string };
const CARD = "rounded-lg border bg-card p-4 shadow-sm";
const json = (value: unknown) => JSON.stringify(value, null, 2);
const show = (value: unknown) => (typeof value === "string" ? value : json(value));

/**
 * The AI page's API tab: the gateway's catalog on the left; on the right the picked
 * call as code (cURL and the OpenAI SDKs) and tried for real with the workspace's
 * own key. `baseUrl` = the gateway's /v1.
 */
export function AiPlayground({ baseUrl, onCreateKey }: { baseUrl: string; onCreateKey?: () => void }) {
  const { data, error, isLoading } = useAiApiCatalog();
  const [endpointId, setEndpointId] = useState("chat");
  if (isLoading) return <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />;
  if (error || !data) return <p className="text-sm text-destructive">{(error as Error)?.message}</p>;
  return <PlaygroundBody catalog={data} origin={baseUrl.replace(/\/v1\/?$/, "")} endpointId={endpointId} onEndpoint={setEndpointId} onCreateKey={onCreateKey} />;
}

function PlaygroundBody({ catalog, origin, endpointId, onEndpoint, onCreateKey }: { catalog: Catalog; origin: string; endpointId: string; onEndpoint: (id: string) => void; onCreateKey?: () => void }) {
  const ep: Endpoint | undefined = catalog.endpoints.find((e) => e.id === endpointId) ?? catalog.endpoints[0];
  const [key, setKey] = useState(loadKey);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const saveKey = (value: string) => {
    setKey(value);
    try {
      sessionStorage.setItem(KEY_STORE, value.trim());
    } catch {
      /* private mode: not remembered */
    }
  };

  // switching call: its example body, with the catalog's example models
  useEffect(() => {
    setBody(ep?.body === undefined ? "" : withVars(json(ep.body), catalog.vars));
    setResult(null);
  }, [ep, catalog.vars]);

  let bodyError: string | null = null;
  try {
    if (body.trim()) JSON.parse(body);
  } catch (e) {
    bodyError = (e as Error).message;
  }
  // multipart calls (image edits) send files: code only
  const canSend = !busy && !!ep && !ep.form && !!key.trim() && !bodyError;

  async function send() {
    if (!ep) return;
    setBusy(true);
    const started = performance.now();
    try {
      const r = await callAiApi({ method: ep.method, path: ep.path, key, ...(body.trim() && { body: JSON.parse(body) }) });
      setResult({ ok: r.ok, status: r.status, model: r.model, ms: Math.round(performance.now() - started), body: show(r.response) });
    } catch (e) {
      setResult({ ok: false, ms: Math.round(performance.now() - started), body: (e as Error).message });
    } finally {
      setBusy(false);
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
        <CatalogList endpoints={catalog.endpoints} selected={ep} onSelect={onEndpoint} />
      </nav>

      {/* explanation left; the same call as code, and tried for real, right */}
      <div className="grid min-w-0 items-start gap-4 xl:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <div className={CARD}>
            <EndpointDoc e={ep} />
          </div>
          <div className={`${CARD} space-y-2`}>
            <Label>
              {t("Example response")} · HTTP {ep.response.status}
            </Label>
            <pre className="max-h-96 overflow-auto rounded-md bg-muted/60 p-3 font-mono text-xs">{withVars(show(ep.response.body), catalog.vars)}</pre>
          </div>
          {catalog.errors && catalog.errors.length > 0 && (
            <div className={`${CARD} space-y-2`}>
              <Label>{t("Errors")}</Label>
              <p className="text-xs text-muted-foreground">
                <Md text="OpenAI's shape: `{error: {message, type, code}}`." />
              </p>
              <table className="w-full text-xs">
                <tbody>
                  {catalog.errors.map((x) => (
                    <tr key={x.code} className="border-b last:border-0 [&>td]:py-1.5 [&>td]:pr-3 [&>td]:align-top">
                      <td className="whitespace-nowrap font-mono">{x.status}</td>
                      <td className="whitespace-nowrap font-mono">{x.code}</td>
                      <td className="text-muted-foreground">
                        <Md text={x.desc} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          <div className={`${CARD} space-y-3`}>
            <Label>{t("Code")}</Label>
            {!bodyError && <CodeExample examples={aiCodeExamples(origin, ep, body.trim(), catalog.vars)} />}
          </div>
          <div className={`${CARD} space-y-4`}>
            <Row id="pg-key" label={t("API key")} hint={t("A key from the Keys tab — shown once, when it is made. Kept in this browser tab only. Calls are billed like any other.")}>
              <div className="flex gap-2">
                <Input id="pg-key" type="password" autoComplete="off" className="min-w-0 flex-1 font-mono text-sm" placeholder="lk_…" value={key} onChange={(e) => saveKey(e.target.value)} />
                {onCreateKey && (
                  <Button variant="outline" onClick={onCreateKey} className="shrink-0">
                    <KeyRound className="mr-2 h-4 w-4" />
                    {t("New key")}
                  </Button>
                )}
              </div>
            </Row>
            {ep.form ? (
              <p className="text-sm text-muted-foreground">{t("This call uploads files: run it with the code above.")}</p>
            ) : (
              ep.body !== undefined && (
                <div className="space-y-1">
                  <Label htmlFor="pg-body">{t("Body (JSON)")}</Label>
                  <Textarea id="pg-body" rows={Math.min(16, body.split("\n").length + 1)} spellCheck={false} className="font-mono text-sm" value={body} onChange={(e) => setBody(e.target.value)} />
                  {bodyError && <p className="text-xs text-destructive">{bodyError}</p>}
                  <p className="text-xs text-muted-foreground">{t("Any model from the Models tab goes in `model`.")}</p>
                </div>
              )
            )}
            {!ep.form && (
              <div className="flex flex-wrap items-center gap-2">
                <Button disabled={!canSend} onClick={() => void send()} title="Ctrl+Enter">
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                  {t("Send")}
                </Button>
                <kbd className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground">Ctrl+Enter</kbd>
              </div>
            )}
          </div>
          {result && (
            <div className={`${CARD} space-y-2`}>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className={`font-semibold ${result.ok ? "text-success" : "text-destructive"}`}>{result.ok ? "OK" : result.status ? `HTTP ${result.status}` : t("Error")}</span>
                <span className="text-muted-foreground">{result.ms} ms</span>
                {result.model && <code className="font-mono text-xs text-muted-foreground">x-larika-model: {result.model}</code>}
              </div>
              <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/60 p-3 font-mono text-xs">{result.body}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
