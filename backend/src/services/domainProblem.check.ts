import assert from 'assert';
import { domainProblem, registrableDomain } from './rdapService';

// the name that was registered, not the host under it
assert.strictEqual(registrableDomain('depatinews.semata.id'), 'semata.id');
assert.strictEqual(registrableDomain('semata.id'), 'semata.id');
assert.strictEqual(registrableDomain('a.shop.co.id'), 'shop.co.id');
assert.strictEqual(registrableDomain('shop.co.id.'), 'shop.co.id');
assert.strictEqual(registrableDomain('co.id'), null);
assert.strictEqual(registrableDomain('localhost'), null);

const now = new Date('2026-09-13T00:00:00Z');
const ok = { status: ['active'], expiresAt: '2027-01-01T00:00:00Z' };
assert.strictEqual(domainProblem(false, ok, now), null);
assert.strictEqual(domainProblem(true, null, now), 'unregistered');
// no authoritative answer is not a problem to report
assert.strictEqual(domainProblem(null, null, now), null);
assert.strictEqual(domainProblem(false, { ...ok, expiresAt: '2026-09-01T00:00:00Z' }, now), 'expired');
assert.strictEqual(domainProblem(false, { ...ok, status: ['redemption period'] }, now), 'expired');
assert.strictEqual(domainProblem(false, { ...ok, status: ['pending delete'] }, now), 'expired');
assert.strictEqual(domainProblem(false, { ...ok, status: ['client hold'] }, now), 'suspended');
assert.strictEqual(domainProblem(false, { ...ok, status: ['serverHold'] }, now), 'suspended');
assert.strictEqual(domainProblem(false, { ...ok, status: ['inactive'] }, now), 'inactive');

console.log('domainProblem: ok');
