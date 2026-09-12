import { Prisma } from '@prisma/client';
import { canEncrypt, encrypt, decrypt } from './secretBox';

/**
 * An application's environment variables at rest.
 *
 * They are the app's secrets (database URLs, API keys), so the column holds
 * `{ "$enc": <secretBox blob> }` rather than the values: a database dump or a
 * list endpoint that returns whole rows no longer hands them out. Rows written
 * before this are a plain object and are read as is — they get encrypted the
 * next time the app's env is saved.
 */

type Env = Record<string, string>;

export function readEnv(stored: unknown): Env {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const sealed = (stored as { $enc?: unknown }).$enc;
  if (typeof sealed === 'string') return JSON.parse(decrypt(sealed)) as Env;
  return Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, String(value)]));
}

let warned = false;

/** What to write to `envVars`. Plaintext only when no CB_SECRET_KEY is set — said once, loudly. */
export function sealEnv(env: Env): Prisma.InputJsonValue {
  if (canEncrypt()) return { $enc: encrypt(JSON.stringify(env)) };
  if (!warned) {
    warned = true;
    console.warn('CB_SECRET_KEY is not set — application env vars are stored unencrypted');
  }
  return env;
}
