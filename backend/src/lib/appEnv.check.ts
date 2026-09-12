/**
 * Self-check for env vars at rest: npx tsx src/lib/appEnv.check.ts
 */
import assert from 'assert';
import { randomBytes } from 'crypto';

process.env.CB_SECRET_KEY ||= randomBytes(32).toString('base64');

(async () => {
  const { readEnv, sealEnv } = await import('./appEnv');

  const env = { DATABASE_URL: 'postgres://u:p@h/db?sslmode=require', QUOTE: `it's "fine"`, EMPTY: '' };
  const sealed = sealEnv(env) as { $enc: string };

  // what lands in the column says nothing about the values
  assert.ok(typeof sealed.$enc === 'string');
  assert.ok(!JSON.stringify(sealed).includes('postgres'), 'values must not be readable at rest');
  assert.deepStrictEqual(readEnv(sealed), env);

  // rows from before encryption still read, as strings
  assert.deepStrictEqual(readEnv({ NODE_ENV: 'production', PORT: 3000 }), { NODE_ENV: 'production', PORT: '3000' });
  // nothing stored → nothing
  assert.deepStrictEqual(readEnv(null), {});
  assert.deepStrictEqual(readEnv([]), {});

  console.log('appEnv: OK');
})();
