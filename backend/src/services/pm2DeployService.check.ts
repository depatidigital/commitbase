/**
 * Self-check for what an in-place pm2 build runs: npx tsx src/services/pm2DeployService.check.ts
 */
import assert from 'assert';
import { packageManager, pm2DeploySteps } from './pm2DeployService';

const argv = (steps: ReturnType<typeof pm2DeploySteps>) => steps.map((step) => step.argv.join(' '));

// the lockfile decides the package manager
assert.strictEqual(packageManager(['package.json', 'pnpm-lock.yaml']), 'pnpm');
assert.strictEqual(packageManager(['yarn.lock']), 'yarn');
assert.strictEqual(packageManager(['bun.lock']), 'bun');
assert.strictEqual(packageManager([]), 'npm');

// install exactly the lockfile, build by the script, restart by name
assert.deepStrictEqual(argv(pm2DeploySteps(['package.json', 'pnpm-lock.yaml'], '{"scripts":{"build":"next build"}}', 'cpnsfokus')), [
  'pnpm install --frozen-lockfile --config.dangerouslyAllowAllBuilds=true',
  'pnpm run build',
  'pm2 restart cpnsfokus',
]);
assert.deepStrictEqual(argv(pm2DeploySteps(['package.json', 'package-lock.json'], '{"scripts":{"build":"tsc"}}', 'api')), [
  'npm ci',
  'npm run build',
  'pm2 restart api',
]);
// no build script: install and restart
assert.deepStrictEqual(argv(pm2DeploySteps(['package.json', 'yarn.lock'], '{"scripts":{"start":"node x"}}', 'w')), [
  'yarn install --frozen-lockfile',
  'pm2 restart w',
]);
// not a Node folder: only the restart
assert.deepStrictEqual(argv(pm2DeploySteps(['server.py'], null, 'py')), ['pm2 restart py']);
// whatever the build script says, it never becomes the command — only `run build` does
assert.deepStrictEqual(pm2DeploySteps(['package.json'], '{"scripts":{"build":"rm -rf / && echo"}}', 'x')[1]!.argv, ['npm', 'run', 'build']);

console.log('pm2DeployService: ok');
