import { useQuery } from '@tanstack/react-query';
import apiRequest from './api';
import { t } from '@/lib/i18n';

// The AI gateway's Client API catalog (larika-ai-gateway src/apiCatalog.ts, served at /docs/catalog.json):
// the AI page's API tab renders it, so a new gateway call shows up here without a panel release.
// `{{model}}`, `{{preset}}`, `{{imageModel}}`, `{{embeddingModel}}` = the catalog's example `vars`.

export type Param = { name: string; in: 'path' | 'query' | 'body' | 'form'; type: string; required?: boolean; desc: string };
export type Endpoint = {
  id: string;
  group: string;
  method: 'GET' | 'POST';
  path: string;
  title: string;
  desc: string;
  params?: Param[];
  /** Example JSON body. */
  body?: unknown;
  /** Example multipart fields instead of a JSON body; `@file` = a file upload. */
  form?: Record<string, string>;
  /** Example response: JSON, or the text of an event stream. */
  response: { status: number; body: unknown };
};
export type Catalog = { vars: Record<string, string>; endpoints: Endpoint[]; errors?: { status: number; code: string; desc: string }[] };

export const getAiApiCatalog = async () => {
  const res = await apiRequest<Catalog>('/ai/api-catalog');
  if (!res.success || !res.data) throw new Error(res.error || t('Failed to fetch the API catalog'));
  return res.data;
};

export const useAiApiCatalog = () => useQuery({ queryKey: ['ai-api-catalog'], queryFn: getAiApiCatalog, staleTime: 10 * 60_000 });

/** One call with the workspace's own key, through the panel (the gateway has no CORS). */
export const callAiApi = async (body: { method: string; path: string; body?: unknown; key: string }) => {
  const res = await apiRequest<{ ok: boolean; status: number; model: string | null; response: unknown }>('/ai/playground', { method: 'POST', body: JSON.stringify(body) });
  if (!res.success || !res.data) throw new Error(res.error || t('Failed to call the API'));
  return res.data;
};

/** {{var}} → the catalog's example value. */
export const withVars = (text: string, vars: Record<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (tag, n: string) => vars[n] ?? tag);

/** A JSON value as a Python literal (True / False / None). */
function py(value: unknown, indent = ''): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  const inner = indent + '    ';
  if (Array.isArray(value)) return value.length ? `[\n${value.map((v) => inner + py(v, inner)).join(',\n')},\n${indent}]` : '[]';
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length ? `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${py(v, inner)}`).join(',\n')},\n${indent}}` : '{}';
}

/** Python keyword arguments from a JSON body: model="…", messages=[…]. */
const pyArgs = (body: Record<string, unknown>) => Object.entries(body).map(([k, v]) => `    ${k}=${py(v, '    ')},`).join('\n');

/** The SDK method each Client API path is. */
const SDK: Record<string, { js: string; py: string }> = {
  '/v1/models': { js: 'ai.models.list', py: 'ai.models.list' },
  '/v1/chat/completions': { js: 'ai.chat.completions.create', py: 'ai.chat.completions.create' },
  '/v1/images/generations': { js: 'ai.images.generate', py: 'ai.images.generate' },
  '/v1/images/edits': { js: 'ai.images.edit', py: 'ai.images.edit' },
  '/v1/embeddings': { js: 'ai.embeddings.create', py: 'ai.embeddings.create' },
};

/**
 * The code an app would run for this call: cURL, and the OpenAI SDKs pointed at the
 * gateway. `origin` = the gateway without /v1 (catalog paths carry it).
 */
export function aiCodeExamples(origin: string, e: Pick<Endpoint, 'method' | 'path' | 'form'>, body: string, vars: Record<string, string> = {}) {
  const url = `${origin}${e.path}`;
  const base = `${origin}/v1`;
  const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : null;
  const stream = !!parsed?.stream;
  const sdk = SDK[e.path];
  const fields = e.form && Object.fromEntries(Object.entries(e.form).map(([k, v]) => [k, withVars(v, vars)]));

  const curl = fields
    ? [`curl ${url}`, `  -H "Authorization: Bearer $LARIKA_AI_KEY"`, ...Object.entries(fields).map(([k, v]) => `  -F "${k}=${v}"`)].join(' \\\n')
    : [
        `curl ${stream ? '-N ' : ''}${e.method === 'GET' ? '' : '-X POST '}${url}`,
        `  -H "Authorization: Bearer $LARIKA_AI_KEY"`,
        ...(parsed ? [`  -H "content-type: application/json"`, `  -d '${JSON.stringify(parsed).replace(/'/g, "'\\''")}'`] : []),
      ].join(' \\\n');
  const examples = [{ label: 'cURL', code: curl }];
  if (!sdk) return examples;

  // multipart: files as streams, the rest as they are
  const form = fields && Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.startsWith('@') ? { file: v.slice(1) } : v]));
  const jsArgs = form
    ? `{\n${Object.entries(form).map(([k, v]) => `  ${k}: ${typeof v === 'string' ? JSON.stringify(v) : `fs.createReadStream(${JSON.stringify(v.file)})`},`).join('\n')}\n}`
    : parsed
      ? JSON.stringify(parsed, null, 2).replace(/^(\s*)"([A-Za-z_$][\w$]*)":/gm, '$1$2:')
      : '';
  const pyCall = form
    ? Object.entries(form).map(([k, v]) => `    ${k}=${typeof v === 'string' ? JSON.stringify(v) : `open(${JSON.stringify(v.file)}, "rb")`},`).join('\n')
    : parsed
      ? pyArgs(parsed)
      : '';
  const jsOut = stream
    ? 'for await (const chunk of res) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");'
    : parsed?.tools
      ? 'console.log(res.choices[0].message.tool_calls);'
      : e.path === '/v1/chat/completions'
        ? 'console.log(res.choices[0].message.content);'
      : 'console.log(res);';
  const pyOut = stream
    ? 'for chunk in res:\n    if chunk.choices:\n        print(chunk.choices[0].delta.content or "", end="")'
    : parsed?.tools
      ? 'print(res.choices[0].message.tool_calls)'
      : e.path === '/v1/chat/completions'
        ? 'print(res.choices[0].message.content)'
      : 'print(res)';

  examples.push(
    {
      label: 'Node.js',
      code: `import OpenAI from "openai";${form ? '\nimport fs from "node:fs";' : ''}

const ai = new OpenAI({ baseURL: "${base}", apiKey: process.env.LARIKA_AI_KEY });
const res = await ${sdk.js}(${jsArgs});
${jsOut}`,
    },
    {
      label: 'Python',
      code: `import os
from openai import OpenAI

ai = OpenAI(base_url="${base}", api_key=os.environ["LARIKA_AI_KEY"])
res = ${sdk.py}(${pyCall ? `\n${pyCall}\n` : ''})
${pyOut}`,
    },
  );
  return examples;
}
