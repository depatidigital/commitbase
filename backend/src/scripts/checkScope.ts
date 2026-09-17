import assert from 'node:assert/strict';
import { canManageProject, candidateParents, projectScope } from '../lib/scope';

// Self-check for the hostname → parent-domain logic that guards tenant isolation.
// Run: npx tsx src/scripts/checkScope.ts

assert.deepEqual(candidateParents('api.staging.client.com'), [
  'api.staging.client.com',
  'staging.client.com',
  'client.com',
]);

assert.deepEqual(candidateParents('client.com'), ['client.com']);

// a bare label can never match a domain row
assert.deepEqual(candidateParents('localhost'), []);

// case and trailing dot are normalized
assert.deepEqual(candidateParents('APP.Client.COM.'), ['app.client.com', 'client.com']);

// the classic bypass: a lookalike suffix must not match the victim's domain
assert.ok(!candidateParents('evil-client.com').includes('client.com'));
assert.ok(!candidateParents('clientXcom').includes('client.com'));

// Project access for a user in several orgs: ADMIN of A, MEMBER of B.
// Memberships are memoized on the request, so no database is needed.
const req = (role: string) =>
  ({
    user: { userId: 'u1', role },
    _memberships: [
      { organizationId: 'A', role: 'ADMIN' },
      { organizationId: 'B', role: 'MEMBER' },
    ],
  }) as any;

(async () => {
  assert.deepEqual(await projectScope(req('USER')), {
    AND: [
      { organizationId: { in: ['A', 'B'] } },
      { OR: [{ organizationId: { in: ['A'] } }, { createdById: 'u1' }, { members: { some: { userId: 'u1' } } }] },
    ],
  });
  assert.deepEqual(await projectScope(req('ADMIN')), {});

  assert.equal(await canManageProject(req('USER'), { organizationId: 'A', createdById: null }), true);
  assert.equal(await canManageProject(req('USER'), { organizationId: 'B', createdById: null }), false);
  assert.equal(await canManageProject(req('USER'), { organizationId: 'B', createdById: 'u1' }), true);
  // made it, then left that org: no longer theirs
  assert.equal(await canManageProject(req('USER'), { organizationId: 'C', createdById: 'u1' }), false);

  console.log('✅ scope self-check passed');
})();
