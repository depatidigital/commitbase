import assert from 'node:assert';
import { eligibleNodes, pickNode } from './larikaGatewayService';

const node = (id: string, online: boolean, instances: number, capacity = 10) => ({
  id, name: id, capacity, version: null, lastSeenAt: null, paired: true, diskBytes: null, permanent: false, instances, online,
});
const agents = [node('busy', true, 8), node('idle', true, 1), node('off', false, 0), node('full', true, 10), node('disabled', true, 0)];
const disabled = new Set(['disabled']);

// online, enabled, with room — least loaded first: the default
assert.deepStrictEqual(eligibleNodes(agents, disabled).map((a) => a.id), ['idle', 'busy']);
assert.strictEqual(pickNode(agents, disabled), 'idle');
// the one asked for, when it may take a number
assert.strictEqual(pickNode(agents, disabled, 'busy'), 'busy');
// and said why when it may not
assert.throws(() => pickNode(agents, disabled, 'disabled'), /disabled for new numbers/);
assert.throws(() => pickNode(agents, disabled, 'off'), /offline/);
assert.throws(() => pickNode(agents, disabled, 'full'), /capacity/);
assert.throws(() => pickNode(agents, disabled, 'gone'), /not on the gateway/);
// nothing left: the only online node is disabled, or every enabled one is full
assert.throws(() => pickNode([node('disabled', true, 0), node('off', false, 0)], disabled), /No WA node is online/);
assert.throws(() => pickNode([node('full', true, 10)], new Set()), /at capacity/);
console.log('larikaGateway: ok');
