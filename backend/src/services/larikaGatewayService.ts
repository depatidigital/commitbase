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
  ) {
    super(message);
  }
}

export async function gateway<T = any>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const config = await getLarikaGatewayConfig();
  if (!config) throw new GatewayError('The Larika Gateway integration is not set up', 503);
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
    throw new GatewayError(GATEWAY_ERRORS[data?.error] ?? data?.error ?? `Gateway answered ${response.status}`, response.status);
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
};

/** The gateway's own summary: nodes and numbers with live status. */
export type GatewayStats = {
  numbers: Array<{ id: string; name: string; phone: string | null; status: string; qr: string | null; error: string | null; agentId: string | null; webhookUrl: string | null; ipAllowlist: string[]; sent24h: number; updatedAt: string }>;
  agents: Array<{ id: string; name: string; capacity: number; version: string | null; lastSeenAt: string | null; paired: boolean; diskBytes: number | null; permanent: boolean; instances: number; online: boolean }>;
};

export const gatewayStats = () => gateway<GatewayStats>('/admin/stats');

/**
 * Express reply for a failed gateway call. Its 401/403 (our admin key) become
 * 502: passed on, the panel would read them as the user's own session failing.
 */
export const gatewayFailure = (error: any) => ({
  status: error instanceof GatewayError ? ([400, 404, 409, 422, 429].includes(error.status) ? error.status : 502) : 500,
  body: { success: false, error: error instanceof GatewayError ? error.message : 'Gateway request failed' },
});
