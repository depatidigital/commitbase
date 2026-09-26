import apiRequest from './api';
import { t } from '@/lib/i18n';

// The gateway's Client API catalog (larika-wa-gateway src/apiCatalog.ts, served at /docs/catalog.json):
// the API tab and Playground render it, so a new gateway call shows up here without a panel release.
// `{id}` = the number; `{{phone}}`, `{{chat}}`, `{{group}}`, `{{sendId}}`, `{{waMessageId}}` = Playground variables.

export type Param = { name: string; in: 'path' | 'query' | 'body'; type: string; required?: boolean; desc: string };
export type Endpoint = {
  id: string;
  group: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  title: string;
  desc: string;
  params?: Param[];
  /** Playground default query values. */
  query?: Record<string, string>;
  /** Example / Playground default body. */
  body?: unknown;
  /** Example response (status + JSON). */
  response: { status: number; body: unknown };
  /** Changes/removes something real: the Playground asks first. */
  danger?: boolean;
};
export type Catalog = {
  vars: Record<string, string>;
  endpoints: Endpoint[];
  /** events a number POSTs to its webhook URL, and one such POST */
  webhooks?: { events: { event: string; desc: string }[]; example: unknown };
};

export const getWaApiCatalog = async () => {
  const res = await apiRequest<Catalog>('/wa-numbers/api-catalog');
  if (!res.success || !res.data) throw new Error(res.error || t('Failed to fetch the API catalog'));
  return res.data;
};

/** The code an app would run for this call: the same one-switch cURL / Node.js everywhere. */
export function codeExamples(method: string, url: string, body: string) {
  const oneLine = body ? JSON.stringify(JSON.parse(body)) : "";
  return [
    {
      label: "cURL",
      code: [
        `curl -X ${method} '${url}'`,
        `  -H 'Authorization: Bearer lwg_…'`,
        ...(oneLine ? [`  -H 'content-type: application/json'`, `  -d '${oneLine.replace(/'/g, "'\\''")}'`] : []),
      ].join(" \\\n"),
    },
    {
      label: "Node.js",
      code: `const res = await fetch("${url}", {
  method: "${method}",
  headers: { Authorization: \`Bearer \${process.env.LARIKA_API_KEY}\`${oneLine ? ', "content-type": "application/json"' : ""} },${oneLine ? `\n  body: JSON.stringify(${body.replace(/\n/g, "\n  ")}),` : ""}
});
console.log(res.status, await res.json());`,
    },
  ];
}

/** An app checking a webhook is really from the gateway (Node.js). */
export const VERIFY_SNIPPET = `import crypto from "node:crypto";

// rawBody: the request body exactly as received, before JSON parsing
const expected = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
const got = req.headers["x-larika-signature"] ?? "";
if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
  return res.status(401).end();
}
const { id, event, data } = JSON.parse(rawBody); // e.g. event = "message.incoming"
// delivery is at-least-once: skip an id you have already handled
res.status(200).end();`;
