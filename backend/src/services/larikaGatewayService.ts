import { getLarikaGatewayConfig } from './integrationConfigService';

/**
 * The Larika WhatsApp gateway (larika-wa-gateway), called with its management
 * key. It has no tenants: each WhatsApp number (an "instance") owns its API
 * keys, and which workspace a number belongs to is ours to remember (WaNumber).
 * The admin key also works on every /v1/instances/:id route, which is where
 * status, QR, relink and delete live.
 */
export class GatewayError extends Error {
  constructor(
    message: string,
    public status: number,
    /** the gateway's JSON answer, when it gave one */
    public body: unknown = null,
  ) {
    super(message);
  }
}

export type GatewayInit = { method?: string; body?: unknown; timeoutMs?: number };
type GatewayConfig = { baseUrl: string; adminKey: string; adminPath: string | null };

export async function gateway<T = any>(path: string, init: GatewayInit = {}): Promise<T> {
  const config = await getLarikaGatewayConfig();
  if (!config) throw new GatewayError('The Larika Gateway integration is not set up', 503);
  return callGateway<T>(config, path, init);
}

/** A management call to a Larika gateway — this WhatsApp one, or the AI one (aiGatewayService). */
export async function callGateway<T = any>(config: GatewayConfig, path: string, init: GatewayInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'x-admin-key': config.adminKey,
        ...(config.adminPath && { 'x-admin-path': config.adminPath }),
        ...(init.body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
    });
  } catch (error: any) {
    throw new GatewayError(`Gateway unreachable: ${error?.message || error}`, 502);
  }
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    // the gateway's own words: ip_not_allowed, unauthorized, no_agent_online, agents_full…
    throw new GatewayError(GATEWAY_ERRORS[data?.error] ?? data?.error ?? `Gateway answered ${response.status}`, response.status, data);
  }
  return data as T;
}

const GATEWAY_ERRORS: Record<string, string> = {
  unauthorized: 'The gateway rejected the admin key',
  ip_not_allowed: "The gateway does not allow this server's IP — add it to ADMIN_IP_ALLOWLIST or set the admin path",
  no_agent_online: 'No WA node is online to run this number',
  agents_full: 'Every WA node is at capacity',
  instance_not_found: 'The number is not on the gateway any more',
  agent_not_found: 'The node is not on the gateway any more',
  agent_offline: 'The WA node running this number is offline',
  account_not_found: 'The AI account is not on the gateway any more',
  key_not_found: 'The key is not on the gateway any more',
  no_webhook_url: 'Set a webhook URL on the number first',
};

/** The gateway's own summary: nodes and numbers with live status. */
export type GatewayStats = {
  numbers: Array<{ id: string; name: string; phone: string | null; status: string; qr: string | null; error: string | null; agentId: string | null; webhookUrl: string | null; ipAllowlist: string[]; sent24h: number; updatedAt: string }>;
  agents: Array<{ id: string; name: string; capacity: number; version: string | null; lastSeenAt: string | null; paired: boolean; diskBytes: number | null; permanent: boolean; instances: number; online: boolean }>;
};

export const gatewayStats = () => gateway<GatewayStats>('/admin/stats');

type Agent = GatewayStats['agents'][number];

/** The nodes a new number may go to — online, enabled, with room — least loaded first. Pure. */
export const eligibleNodes = (agents: Agent[], disabled: Set<string>): Agent[] =>
  agents
    .filter((a) => a.online && !disabled.has(a.id) && a.instances < a.capacity)
    .sort((x, y) => x.instances / x.capacity - y.instances / y.capacity);

/**
 * The node for a new number: the one asked for when it may take one, else the
 * least loaded. Throws the gateway's own words when there is none. Pure.
 */
export function pickNode(agents: Agent[], disabled: Set<string>, wanted?: string | null): string {
  const eligible = eligibleNodes(agents, disabled);
  if (wanted) {
    if (eligible.some((a) => a.id === wanted)) return wanted;
    const node = agents.find((a) => a.id === wanted);
    throw new GatewayError(
      !node ? GATEWAY_ERRORS.agent_not_found! : disabled.has(wanted) ? `${node.name} is disabled for new numbers` : !node.online ? `${node.name} is offline` : `${node.name} is at capacity`,
      409,
    );
  }
  if (eligible[0]) return eligible[0].id;
  const enabled = agents.filter((a) => !disabled.has(a.id));
  throw new GatewayError(enabled.some((a) => a.online) ? GATEWAY_ERRORS.agents_full! : GATEWAY_ERRORS.no_agent_online!, 409);
}

/**
 * Express reply for a failed gateway call. Its 401/403 (our admin key) become
 * 502: passed on, the panel would read them as the user's own session failing.
 */
export const gatewayFailure = (error: any) => ({
  status: error instanceof GatewayError ? ([400, 404, 409, 422, 429].includes(error.status) ? error.status : 502) : 500,
  body: { success: false, error: error instanceof GatewayError ? error.message : 'Gateway request failed' },
});
