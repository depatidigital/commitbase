// npx tsx src/lib/emailRules.check.ts — Email Watcher's matching, parsing and sender check.
import assert from 'node:assert/strict';
import { type Condition, type Field, extractFields, firstHeader, headerMayMatch, isPrivateIp, parseAmount, picksEmails, renderTemplate, ruleMatches, searchTerms, senderVerified, validConditions, validFields } from './emailRules';

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
const bni = { from: '"BNI Merchant" <noreply@bni.co.id>', subject, text: 'DEPATI AKADEMI Pembayaran Berhasil No Referensi: F1260PIQ9P' };
const c = (field: 'from' | 'subject' | 'body', op: Condition['op'], value: string): Condition => ({ field, op, value });
const all = (...conditions: Condition[]) => ({ match: 'all' as const, conditions });
const any = (...conditions: Condition[]) => ({ match: 'any' as const, conditions });

// AND
const rule = all(c('from', 'contains', 'bni'), c('subject', 'contains', 'transaksi sebesar'));
assert.ok(ruleMatches(rule, bni));
assert.ok(!ruleMatches(rule, { ...bni, from: 'Toko <a@b.id>' }));
assert.ok(!ruleMatches(all(...rule.conditions, c('body', 'contains', 'other')), bni));
// OR
assert.ok(ruleMatches(any(c('from', 'contains', 'mandiri'), c('subject', 'contains', 'transaksi')), bni));
assert.ok(!ruleMatches(any(c('from', 'contains', 'mandiri'), c('subject', 'contains', 'tagihan')), bni));
// IN / NOT IN: a comma list, any of which appears
assert.ok(ruleMatches(all(c('subject', 'in', 'DANA, OVO, GoPay')), bni));
assert.ok(!ruleMatches(all(c('subject', 'not_in', 'dana,ovo')), bni));
assert.ok(ruleMatches(all(c('subject', 'not_in', 'ovo, gopay')), bni));
assert.ok(ruleMatches(all(c('body', 'not_contains', 'gagal')), bni));
// equals: the sender's address, name or whole line
assert.ok(ruleMatches(all(c('from', 'equals', 'noreply@bni.co.id')), bni));
assert.ok(ruleMatches(all(c('from', 'equals', 'BNI Merchant')), bni));
assert.ok(!ruleMatches(all(c('from', 'equals', 'bni')), bni));
// regex, case-insensitive; a catastrophic one fails instead of hanging
assert.ok(ruleMatches(all(c('subject', 'regex', 'transaksi sebesar rp [\\d,.]+ dari (dana|ovo)')), bni));
assert.ok(!ruleMatches(all(c('body', 'regex', '(a+)+$')), { ...bni, text: `${'a'.repeat(40)}!` }));
// no condition takes everything; a rule is on only with a positive one
assert.ok(ruleMatches(all(), bni));
assert.ok(!picksEmails(all(c('subject', 'not_in', 'spam'))));
assert.ok(picksEmails(any(c('subject', 'not_in', 'spam'), c('from', 'contains', 'bni'))));
// the header decides alone where it can: body conditions wait for the body
assert.ok(headerMayMatch(all(c('from', 'contains', 'bni'), c('body', 'contains', 'x')), bni));
assert.ok(!headerMayMatch(all(c('from', 'contains', 'mandiri'), c('body', 'contains', 'x')), bni));
assert.ok(headerMayMatch(any(c('from', 'contains', 'mandiri'), c('body', 'contains', 'x')), bni));
assert.ok(!headerMayMatch(any(c('from', 'contains', 'mandiri'), c('subject', 'contains', 'tagihan')), bni));
// server-side SEARCH only for AND's plain contains
assert.deepEqual(searchTerms(rule), { from: 'bni', subject: 'transaksi sebesar' });
assert.deepEqual(searchTerms(any(c('from', 'contains', 'bni'))), {});
assert.deepEqual(searchTerms(all(c('from', 'regex', 'bni'), c('subject', 'in', 'a,b'))), {});
// validation
assert.equal(typeof validConditions([c('subject', 'regex', '(')]), 'string');
assert.equal(typeof validConditions([{ field: 'to', op: 'contains', value: 'x' }]), 'string');
assert.equal(typeof validConditions([c('subject', 'contains', ' ')]), 'string');
assert.deepEqual(validConditions([c('subject', 'in', ' dana ')]), [c('subject', 'in', 'dana')]);

const fields = validFields([
  { name: 'amount', pattern: 'Rp\\s*([\\d.,]+)', type: 'amount' },
  { name: 'source', pattern: 'dari (\\S+) telah berhasil' },
]);
assert.ok(Array.isArray(fields));
assert.deepEqual(extractFields(fields, bni), { amount: 150000, source: 'DANA' });
assert.deepEqual(extractFields(fields, { from: '', subject: 'nothing here', text: '' }), { amount: null, source: null });
// a field reads where it is told: the subject, the body or the sender line
const reference = { name: 'ref', pattern: 'Referensi: (\\S+)', type: 'text' as const };
assert.deepEqual(extractFields([{ ...reference, source: 'body' }], bni), { ref: 'F1260PIQ9P' });
assert.deepEqual(extractFields([{ ...reference, source: 'subject' }], bni), { ref: null });
assert.deepEqual(extractFields([{ name: 'bank', pattern: '@([\\w.]+)>', type: 'text', source: 'from' }], bni), { bank: 'bni.co.id' });
assert.deepEqual((validFields([{ name: 'x', pattern: 'a', source: 'nowhere' }]) as Field[])[0]!.source, 'all');
assert.equal(typeof validFields([{ name: 'x', pattern: '(' }]), 'string');
assert.equal(typeof validFields([{ name: 'bad name', pattern: 'a' }]), 'string');

// a catastrophic pattern times out instead of hanging the process
const started = Date.now();
assert.deepEqual(extractFields([{ name: 'x', pattern: '(a+)+$', type: 'text' }], { from: '', subject: `${'a'.repeat(40)}!`, text: '' }), { x: null });
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
