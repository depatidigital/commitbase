import assert from 'assert';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { shellQuote, buildCommand } from './runner';

const execFileAsync = promisify(execFile);

/**
 * shellQuote is the boundary that replaces execFile's argument array: after
 * this, tenant-controlled strings reach a root shell. So it is checked against
 * a real /bin/sh rather than against an idea of one — the command is built the
 * way exec() builds it and the shell must hand back the exact bytes.
 */
const HOSTILE = [
  '; rm -rf /',
  '$(whoami)',
  '`whoami`',
  "it's",
  "'; touch /tmp/pwned; '",
  '&& echo no',
  '| cat',
  '../../etc/passwd',
  '*',
  '--help',
  '$HOME',
  '"double"',
  'a\nb',
  'a\tb',
  '\\',
  '  spaced  ',
  'ünïcödé',
  '',
];

(async () => {
  for (const arg of HOSTILE) {
    // Exactly how exec() composes it: argv -> one shell string.
    const { stdout } = await execFileAsync('sh', ['-c', buildCommand(['printf', '%s', arg])]);
    assert.strictEqual(stdout, arg, `shell mangled ${JSON.stringify(arg)} -> ${JSON.stringify(stdout)}`);
  }

  // Nothing escapes the quotes, so nothing ever runs as a second command.
  const { stdout: side } = await execFileAsync('sh', [
    '-c',
    buildCommand(['printf', '%s', '; echo INJECTED']),
  ]);
  assert.strictEqual(side, '; echo INJECTED');

  // Multiple arguments stay separate arguments.
  const { stdout: multi } = await execFileAsync('sh', [
    '-c',
    buildCommand(['printf', '[%s]', 'a b', 'c;d']),
  ]);
  assert.strictEqual(multi, '[a b][c;d]');

  assert.strictEqual(shellQuote('plain'), "'plain'");
  assert.strictEqual(shellQuote("it's"), "'it'" + '\\' + "''s'");

  // A NUL cannot survive a shell string, so it is refused rather than silently cut.
  assert.throws(() => shellQuote('a\0b'), /NUL/);

  console.log(`ok — ${HOSTILE.length} hostile arguments round-tripped through /bin/sh`);
})();

// the short lane: 8 channels per node at once, the rest in order, a slot handed straight on
(async () => {
  const { acquireSlot } = await import('./runner');
  const releases = await Promise.all(Array.from({ length: 8 }, () => acquireSlot('node-a')));
  const order: number[] = [];
  const waiting = [1, 2].map((n) => acquireSlot('node-a').then((release) => (order.push(n), release)));
  // another node is not held up by this one
  (await acquireSlot('node-b'))();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(order, [], 'nine and ten wait while eight are open');
  releases[0]!();
  releases[0]!(); // twice is once
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(order, [1], 'one freed slot lets exactly one in, the first in line');
  releases[1]!();
  const [r1, r2] = await Promise.all(waiting);
  assert.deepStrictEqual(order, [1, 2]);
  [r1, r2, ...releases.slice(2)].forEach((release) => release!());
  // all given back: eight more fit at once
  const again = await Promise.all(Array.from({ length: 8 }, () => acquireSlot('node-a')));
  again.forEach((release) => release());
  console.log('ok — channel slots: limited per node, first come first served');
})();
