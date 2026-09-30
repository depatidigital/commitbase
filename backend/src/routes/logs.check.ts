import assert from 'node:assert';
import { joinStream } from './logs';

// viewers of one log share one follow on the node; a latecomer gets what it missed
(async () => {
  const node = { id: 'n1', hostname: 'n1', sshUser: 'x', sshPort: 22 };
  let started = 0;
  let push: (text: string) => void = () => {};
  let stopped = false;
  const follow = (send: (text: string) => void, signal: AbortSignal) => {
    started++;
    push = send;
    return new Promise<void>((resolve) => signal.addEventListener('abort', () => ((stopped = true), resolve()), { once: true }));
  };
  const a: string[] = [];
  const b: string[] = [];
  const first = joinStream(node, 'app:1:combined', follow, (t) => a.push(t))!;
  push('one\n');
  const second = joinStream(node, 'app:1:combined', follow, (t) => b.push(t))!;
  push('two\n');
  assert.strictEqual(started, 1, 'the second viewer joins, no second tail');
  assert.deepStrictEqual(a, ['one\n', 'two\n']);
  assert.deepStrictEqual(b, ['one\n', 'two\n'], 'the latecomer gets the backlog first');
  first.leave();
  second.leave();
  assert.strictEqual(stopped, false, 'lingers a moment after the last viewer leaves');

  // the cap counts distinct logs on a node, not viewers
  const extra = Array.from({ length: 5 }, (_, i) => joinStream(node, `app:x${i}:combined`, follow, () => {}));
  assert.ok(extra.every(Boolean), 'six distinct logs fit');
  assert.strictEqual(joinStream(node, 'app:x9:combined', follow, () => {}), null, 'the seventh is refused');
  console.log('ok — log streams: shared per log, backlog replayed, capped per node');
  process.exit(0);
})();
