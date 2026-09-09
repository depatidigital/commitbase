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
