import assert from 'assert';
import { buildKeyOf, groupBuildKey } from './buildKey';

const app = { type: 'NODEJS', installCommand: null, buildCommand: 'pnpm build', preDeployCommand: null };
const key = buildKeyOf(app, 'abc', { A: '1', B: '2' });

// same inputs, env in any order: same build
assert.strictEqual(buildKeyOf(app, 'abc', { B: '2', A: '1' }), key);
// a new commit, an env value, or a build setting: a new build
assert.notStrictEqual(buildKeyOf(app, 'abd', { A: '1', B: '2' }), key);
assert.notStrictEqual(buildKeyOf(app, 'abc', { A: '1', B: '3' }), key);
assert.notStrictEqual(buildKeyOf({ ...app, buildCommand: 'pnpm build:prod' }, 'abc', { A: '1', B: '2' }), key);
// "" and unset are the same setting
assert.strictEqual(buildKeyOf({ ...app, installCommand: '' }, 'abc', { A: '1', B: '2' }), key);

// an app at the repository root keeps the key it had before monorepo folders
assert.strictEqual(buildKeyOf({ ...app, rootDirectory: null }, 'abc', { A: '1', B: '2' }), key);
assert.notStrictEqual(buildKeyOf({ ...app, rootDirectory: 'apps/web' }, 'abc', { A: '1', B: '2' }), key);
// one app: its own key; several: one key that changes with any of them
assert.strictEqual(groupBuildKey([key]), key);
const other = buildKeyOf({ ...app, rootDirectory: 'apps/api' }, 'abc', {});
assert.notStrictEqual(groupBuildKey([key, other]), groupBuildKey([key, buildKeyOf({ ...app, rootDirectory: 'apps/api' }, 'abc', { X: '1' })]));

console.log('buildKey: ok');
