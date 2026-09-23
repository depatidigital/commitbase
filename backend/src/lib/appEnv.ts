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

/** Per-file env: { "<file>": { KEY: value } } — the env files after the first. */
export type EnvFiles = Record<string, Env>;

/** `extraEnvVars`, read: sealed as one blob, like envVars. */
export function readEnvFiles(stored: unknown): EnvFiles {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const sealed = (stored as { $enc?: unknown }).$enc;
  const plain = typeof sealed === 'string' ? JSON.parse(decrypt(sealed)) : stored;
  return Object.fromEntries(Object.entries(plain as Record<string, unknown>).map(([file, env]) => [file, readEnv(env)]));
}

/** What to write to `extraEnvVars`; files with nothing in them are left out. */
export function sealEnvFiles(files: EnvFiles): Prisma.InputJsonValue {
  const kept = Object.fromEntries(Object.entries(files).filter(([, env]) => Object.keys(env).length > 0));
  if (canEncrypt()) return { $enc: encrypt(JSON.stringify(kept)) };
  return kept;
}

/**
 * The variables one env file gets: the first file the app's env (envVars — what
 * the build and the service also get, with whatever the deploy added), every
 * other file its own from extraEnvVars.
 */
export function envForFile(file: string, index: number, env: Env, extra: EnvFiles): Env {
  return index === 0 ? env : extra[file] ?? {};
}
