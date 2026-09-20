/**
 * Build output reaches build.log while the build runs.
 * Run: npx tsx src/services/deployment.check.ts
 */
import assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { buildBlock, buildFailureText, buildScript, dotenvLine, guardedPrune, pruneOf } from './deployment';
import { parseEnv } from 'util';

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

// devDependencies pruned after the build — unless the start command runs one
assert.strictEqual(pruneOf({ pruneDevDeps: false }, { packageManager: 'pnpm', startCommand: 'node dist/index.js' }), null);
assert.strictEqual(pruneOf({ pruneDevDeps: true }, { packageManager: 'pnpm', startCommand: 'node dist/index.js' }), 'pnpm prune --prod');
assert.strictEqual(pruneOf({ pruneDevDeps: true, startCommand: 'tsx src/index.ts' }, { packageManager: 'pnpm', startCommand: null }), null);
assert.strictEqual(pruneOf({ pruneDevDeps: true }, { packageManager: 'npm', startCommand: 'nodemon server.js' }), null);
assert.strictEqual(pruneOf({ pruneDevDeps: true }, { packageManager: 'bun', startCommand: 'bun dist/index.js' }), null);
console.log('deployment: pruneOf OK');

// a pruned devDependency that .next/node_modules links to is reinstalled (needs real symlinks: not on Windows)
if (process.platform !== 'win32') {
  const { mkdtempSync, mkdirSync, symlinkSync, existsSync } = require('fs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'prune-'));
  mkdirSync(`${dir}/node_modules/pg`, { recursive: true });
  mkdirSync(`${dir}/.next/node_modules`, { recursive: true });
  symlinkSync('../../node_modules/pg', `${dir}/.next/node_modules/pg-abc123`);
  const script = guardedPrune('rm -rf node_modules/pg', dir, 'mkdir -p node_modules/pg');
  const out = execFileSync('bash', ['-euo', 'pipefail', '-c', script], { cwd: dir, encoding: 'utf8' });
  assert.ok(existsSync(`${dir}/node_modules/pg`) && out.includes('pg-abc123'), out);
  // nothing dangling → nothing reinstalled
  assert.strictEqual(execFileSync('bash', ['-euo', 'pipefail', '-c', guardedPrune('true', dir, 'echo reinstalled')], { cwd: dir, encoding: 'utf8' }), '');
  console.log('deployment: guardedPrune OK');
}

// a build the kernel killed prints no error of its own: the exit code is the whole diagnosis
assert.ok(buildFailureText({ code: 137, stderr: 'Collecting page data ...' }).startsWith('Killed (exit 137)'));
assert.ok(buildFailureText({ code: 137, stderr: 'out' }).endsWith('out'), 'the output is kept under the reason');
assert.ok(buildFailureText({ code: 1, stderr: 'Type error' }).startsWith('Exit 1'));
// a timeout has no exit code: its message is the only thing saying what happened
assert.ok(buildFailureText({ code: null, message: 'Command timed out after 900000ms', stderr: 'compiling' }).startsWith('Command timed out'));
assert.strictEqual(buildFailureText(new Error('no code')), 'no code');
console.log('deployment: buildFailureText OK');

// the build's Node heap is derived from the cgroup cap, halved for the workers it forks
import { BUILD_HEAP_MB } from './orgProvisionService';
if (!process.env.BUILD_MEMORY_MAX) {
  assert.strictEqual(BUILD_HEAP_MB, 1536, 'default 3G cap -> 1536 MiB heap');
  console.log('deployment: BUILD_HEAP_MB OK', BUILD_HEAP_MB);
}
