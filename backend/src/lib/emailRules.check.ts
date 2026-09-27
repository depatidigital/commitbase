// npx tsx src/lib/emailRules.check.ts — Email Watcher's matching, parsing and sender check.
import assert from 'node:assert/strict';
import { extractFields, firstHeader, isPrivateIp, parseAmount, renderTemplate, ruleMatches, senderVerified, validFields } from './emailRules';

// amounts as banks write them
assert.equal(parseAmount('150,000.00'), 150000);
assert.equal(parseAmount('150.000,00'), 150000);
assert.equal(parseAmount('Rp 1.250.000'), 1250000);
assert.equal(parseAmount('1.500'), 1500);
assert.equal(parseAmount('1,500'), 1500);
assert.equal(parseAmount('150,50'), 150.5);
assert.equal(parseAmount('600000'), 600000);
assert.equal(parseAmount('abc'), null);

// the BNI Merchant subject from the screenshot
const subject = 'BNI Merchant - Transaksi Sebesar Rp 150,000.00 dari DANA telah berhasil';
const rule = { fromContains: 'bni', subjectContains: 'transaksi sebesar', bodyContains: '' };
assert.ok(ruleMatches(rule, { from: 'BNI Merchant <merchant@bni.co.id>', subject, text: '' }));
assert.ok(!ruleMatches(rule, { from: 'Toko <a@b.id>', subject, text: '' }));
assert.ok(!ruleMatches({ ...rule, bodyContains: 'DEPATI' }, { from: 'BNI <x@bni.co.id>', subject, text: 'other' }));

const fields = validFields([
  { name: 'amount', pattern: 'Rp\\s*([\\d.,]+)', type: 'amount' },
  { name: 'source', pattern: 'dari (\\S+) telah berhasil' },
]);
assert.ok(Array.isArray(fields));
assert.deepEqual(extractFields(fields, subject), { amount: 150000, source: 'DANA' });
assert.deepEqual(extractFields(fields, 'nothing here'), { amount: null, source: null });
assert.equal(typeof validFields([{ name: 'x', pattern: '(' }]), 'string');
assert.equal(typeof validFields([{ name: 'bad name', pattern: 'a' }]), 'string');

// a catastrophic pattern times out instead of hanging the process
const started = Date.now();
assert.deepEqual(extractFields([{ name: 'x', pattern: '(a+)+$', type: 'text' }], `${'a'.repeat(40)}!`), { x: null });
assert.ok(Date.now() - started < 2_000);

assert.equal(renderTemplate('Masuk Rp {amount} dari {source} {nope}', { amount: 150000, source: 'DANA' }), 'Masuk Rp 150000 dari DANA {nope}');

// sender check: only the first Authentication-Results counts
const raw = [
  'Authentication-Results: mx.google.com;',
  '       dkim=pass header.i=@bni.co.id;',
  '       dmarc=pass (p=REJECT) header.from=bni.co.id',
  'Authentication-Results: forged; dkim=pass header.d=evil.com',
  'Subject: hi',
  '',
  'Authentication-Results: body text',
].join('\r\n');
const ar = firstHeader(raw, 'authentication-results');
assert.ok(ar?.startsWith('mx.google.com;'));
assert.ok(senderVerified(ar, 'merchant@bni.co.id'));
assert.ok(senderVerified(ar, 'noreply@mail.bni.co.id'));
assert.ok(!senderVerified(ar, 'merchant@bni-co.id'));
assert.ok(!senderVerified('mx.google.com; dkim=pass header.d=evil.com; dmarc=fail header.from=bni.co.id', 'a@bni.co.id'));
assert.ok(!senderVerified(undefined, 'a@bni.co.id'));
assert.ok(!senderVerified('x; dkim=fail header.d=bni.co.id', 'a@bni.co.id'));

assert.ok(isPrivateIp('127.0.0.1') && isPrivateIp('10.1.2.3') && isPrivateIp('172.20.0.1') && isPrivateIp('192.168.1.1'));
assert.ok(isPrivateIp('169.254.169.254') && isPrivateIp('::1') && isPrivateIp('::ffff:127.0.0.1') && isPrivateIp('fd00::1'));
assert.ok(!isPrivateIp('142.250.4.108') && !isPrivateIp('172.32.0.1'));

console.log('emailRules: ok');
