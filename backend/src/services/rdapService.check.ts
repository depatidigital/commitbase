import assert from 'assert';
import { getDomainExpiry } from './rdapService';

(async () => {
  assert.strictEqual(await getDomainExpiry(''), null);
  assert.strictEqual(await getDomainExpiry('not a domain'), null);
  assert.strictEqual(await getDomainExpiry('localhost'), null);

  const d = await getDomainExpiry('google.com');
  assert.ok(d instanceof Date && d.getTime() > Date.now(), `expected future date, got ${d}`);
  console.log('google.com expires', d?.toISOString());

  assert.strictEqual(await getDomainExpiry('zzz-nope-not-registered-12345.com'), null);
  console.log('ok');
})();
