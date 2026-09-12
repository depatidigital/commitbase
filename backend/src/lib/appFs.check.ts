/**
 * Self-check for the command wrapper remote AppFs runs on a node:
 *   npx tsx src/lib/appFs.check.ts      (needs a POSIX sh on PATH)
 *
 * Runs the generated argv through a real sh, locally, and checks the parts
 * that matter: the secret arrives via stdin and never appears in argv, cwd is
 * honoured, umask is 002, and a hostile env name or value is refused.
 */
import assert from 'assert';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { remoteCommand } from './appFs';

const SECRET = 'glpat-s3cret value with spaces';
const dir = mkdtempSync(join(tmpdir(), 'appfs-check-'));

try {
  const wrapped = remoteCommand(['sh', '-c', 'printf "%s|%s|%s" "$CB_GIT_TOKEN" "$(pwd -P)" "$(umask)"'], {
    cwd: dir,
    env: { CB_GIT_TOKEN: SECRET },
  });

  // the token rides on stdin only
  assert.ok(!wrapped.argv.join(' ').includes(SECRET), 'secret must not be in argv');
  assert.strictEqual(wrapped.input, SECRET + '\n');

  const [cmd, ...args] = wrapped.argv;
  const out = execFileSync(cmd!, args, { input: wrapped.input, encoding: 'utf8' });
  const [token, cwd, umask] = out.split('|');
  assert.strictEqual(token, SECRET, 'command sees the secret in its environment');
  assert.ok(cwd && cwd.length > 0 && dir.replace(/\\/g, '/').toLowerCase().includes(cwd.split('/').pop()!.toLowerCase()), `cwd honoured (got ${cwd})`);
  assert.strictEqual(umask, '0002');

  // no env: no stdin to feed, argv still execs
  const plain = remoteCommand(['echo', 'ok']);
  assert.strictEqual(plain.input, undefined);
  assert.strictEqual(execFileSync(plain.argv[0]!, plain.argv.slice(1), { encoding: 'utf8' }).trim(), 'ok');

  // a name that would be shell syntax, or a value that would end the read early
  assert.throws(() => remoteCommand(['true'], { env: { 'X;rm -rf /': 'v' } }), /Invalid environment variable name/);
  assert.throws(() => remoteCommand(['true'], { env: { TOKEN: 'a\nb' } }), /newline/);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('appFs: remoteCommand OK');
