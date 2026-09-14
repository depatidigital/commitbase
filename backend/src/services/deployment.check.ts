/**
 * Build output reaches build.log while the build runs.
 * Run: npx tsx src/services/deployment.check.ts
 */
import assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { buildBlock, buildScript, dotenvLine, streamToLog } from './deployment';
import { parseEnv } from 'util';

(async () => {
  const log = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'cb-log-')), 'build.log');
  await fs.writeFile(log, 'BUILD STARTED\n');

  await streamToLog(process.execPath, ['-e', 'console.log("out"); console.error("err")'], log, 10000);
  const text = await fs.readFile(log, 'utf-8');
  assert.ok(text.startsWith('BUILD STARTED\n'), 'appends, never truncates');
  assert.ok(text.includes('out') && text.includes('err'), 'stdout and stderr both land');

  await assert.rejects(streamToLog(process.execPath, ['-e', 'process.exit(3)'], log, 10000), /code 3/);
  await assert.rejects(streamToLog(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], log, 200), /killed/);

  console.log('deployment: streamToLog OK');
  process.exit(0);
})();

// .env lines read back verbatim by Node's own loader (process.loadEnvFile uses parseEnv)
for (const value of [
  'postgresql://u:p$w0rd@127.0.0.1:5432/db?sslmode=require',
  'has "double" quotes and a # hash',
  'spaces  and = signs',
  'line one\nline two',
  "it's quoted",
  `mixed 'single' and "double"`,
  '',
]) {
  const parsed = parseEnv(dotenvLine('K', value));
  assert.strictEqual(parsed.K, value, `round trip of ${JSON.stringify(value)}`);
}
console.log('deployment: dotenvLine OK');

// build.sh for a monorepo: one install at the root, each app built in its own
// folder with its own env — run for real with bash.
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-build-'));
  await fs.mkdir(path.join(root, 'apps', 'web'), { recursive: true });
  await fs.mkdir(path.join(root, 'apps', 'api'), { recursive: true });
  // the paths as bash sees them (WSL on a Windows box)
  const bashRoot = execFileSync('bash', ['-c', 'pwd'], { cwd: root }).toString().trim();
  const at = (p: string) => `${bashRoot}/${p}`;
  const run = (script: string) => {
    require('fs').writeFileSync(path.join(root, 'build.sh'), script);
    return execFileSync('bash', ['build.sh'], { cwd: root, stdio: 'pipe' }).toString();
  };

  const block = (name: string, env: Record<string, string>, installs: string[], steps: string[]) =>
    buildBlock({ heading: name, nodeVersion: null, env, installDir: bashRoot, installs, workDir: at(`apps/${name}`), steps });

  run(
    buildScript([
      block('web', { WHO: 'web', TRICKY: `it's $(id) "q"` }, ['echo installed >> installs.log'], ['echo "$WHO $TRICKY" > built.txt']),
      block('api', { WHO: 'api' }, [], ['echo "$WHO ${TRICKY-unset} $(basename "$PWD")" > built.txt']),
    ]),
  );
  const read = (p: string) => fs.readFile(path.join(root, p), 'utf-8');
  assert.strictEqual(await read('apps/web/built.txt'), `web it's $(id) "q"\n`, 'env values reach the build verbatim');
  assert.strictEqual(await read('apps/api/built.txt'), 'api unset api\n', "one app's env never reaches the next; each builds in its folder");
  assert.strictEqual(await read('installs.log'), 'installed\n', 'install ran once, at the root');

  // a failing step fails the whole build, and nothing after it runs
  assert.throws(() => run(buildScript([block('web', {}, [], ['false']), block('api', {}, [], ['touch after'])])));
  assert.ok(!(await fs.stat(path.join(root, 'apps', 'api', 'after')).catch(() => null)), 'the next app does not build after a failure');
  console.log('deployment: monorepo build.sh OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
