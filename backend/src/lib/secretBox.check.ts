/**
 * Self-check for the secret box: npx tsx src/lib/secretBox.check.ts
 */
import assert from 'assert';

process.env.CB_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');

// imported after the key is set — the module reads it lazily, and this proves it
const { encrypt, decrypt, canEncrypt } = require('./secretBox');

assert.strictEqual(canEncrypt(), true);

const secret = 'correct horse battery staple';
const blob = encrypt(secret);

assert.notStrictEqual(blob, secret, 'ciphertext must not be the plaintext');
assert.ok(blob.startsWith('v1:'), 'versioned, so the format can change later');
assert.strictEqual(decrypt(blob), secret);

// same plaintext twice must not produce the same blob — the IV is per message
assert.notStrictEqual(encrypt(secret), encrypt(secret));

// a tampered tag must fail loudly rather than decrypt to garbage
const [version, iv, , body] = blob.split(':');
const forged = [version, iv, Buffer.alloc(16, 1).toString('base64'), body].join(':');
assert.throws(() => decrypt(forged));

// and a missing key is a clear error, not a silent plaintext write
delete process.env.CB_SECRET_KEY;
assert.strictEqual(canEncrypt(), false);
assert.throws(() => encrypt(secret), /CB_SECRET_KEY/);

console.log('secretBox: encrypt/decrypt OK');
