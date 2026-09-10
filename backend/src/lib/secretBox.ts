import * as crypto from 'crypto';

/**
 * Symmetric encryption for secrets that have to be stored and read back.
 *
 * An SSH password is the credential for a shell on a tenant box, so it does not
 * go in a column as plain text. AES-256-GCM: the tag makes a tampered
 * ciphertext fail to decrypt instead of decrypting to garbage that ends up in
 * an ssh handshake.
 *
 * The key lives in `CB_SECRET_KEY` — 32 bytes, base64 or hex:
 *
 *   openssl rand -base64 32
 *
 * ponytail: one key, no rotation. Re-encrypting every stored secret under a new
 * key needs a key id in the blob; add it when a rotation is actually planned.
 */

const PREFIX = 'v1';

function key(): Buffer {
  const raw = (process.env.CB_SECRET_KEY || '').trim();
  if (!raw) {
    throw new Error('CB_SECRET_KEY is not set — required to store or read an encrypted secret');
  }

  const decoded = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (decoded.length !== 32) {
    throw new Error('CB_SECRET_KEY must be 32 bytes (openssl rand -base64 32)');
  }
  return decoded;
}

/** True when a key is configured, so a caller can refuse the write with a clear message. */
export function canEncrypt(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return [PREFIX, iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(
    ':',
  );
}

export function decrypt(blob: string): string {
  const [version, iv, tag, body] = String(blob).split(':');
  if (version !== PREFIX || !iv || !tag || !body) {
    throw new Error('Stored secret is not in the expected format');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));

  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}
