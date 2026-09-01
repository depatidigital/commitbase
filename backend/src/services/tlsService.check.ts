import assert from 'assert';
import { getTlsCertificate } from './tlsService';

(async () => {
  assert.strictEqual(await getTlsCertificate(''), null);
  assert.strictEqual(await getTlsCertificate('not a domain'), null);
  assert.strictEqual(await getTlsCertificate('localhost'), null);

  const good = await getTlsCertificate('google.com');
  assert.ok(good, 'expected a certificate for google.com');
  assert.strictEqual(good.status, 'ACTIVE');
  assert.ok(good.expiry && good.expiry.getTime() > Date.now(), 'expected a future expiry');
  console.log('google.com', good.status, good.issuer, good.expiry?.toISOString());

  // badssl publishes deliberately broken certificates
  const expired = await getTlsCertificate('expired.badssl.com');
  assert.strictEqual(expired?.status, 'EXPIRED', `expected EXPIRED, got ${expired?.status}`);

  const selfSigned = await getTlsCertificate('self-signed.badssl.com');
  assert.strictEqual(selfSigned?.status, 'ERROR', `expected ERROR, got ${selfSigned?.status}`);

  // nothing listening on 443 is "unknown", not "broken"
  assert.strictEqual(await getTlsCertificate('zzz-nope-not-registered-12345.com'), null);
  console.log('ok');
})();
