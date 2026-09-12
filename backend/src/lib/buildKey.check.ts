import assert from 'assert';
import { buildKeyOf } from './buildKey';

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

console.log('buildKey: ok');
