import assert from 'assert';
import { detectFromFiles, nvmPreamble, parseLsRemote, parseEnvFile, presenceOnly } from './projectDetect';

const NL = String.fromCharCode(10);

// npx tsx src/lib/projectDetect.check.ts

const next = detectFromFiles({
  'package.json': JSON.stringify({ dependencies: { next: '15.0.0' }, scripts: { build: 'next build', start: 'next start' } }),
  'pnpm-lock.yaml': '',
  '.nvmrc': 'v20.11\n',
});
assert.strictEqual(next.framework, 'nextjs');
assert.strictEqual(next.type, 'NODEJS');
assert.strictEqual(next.packageManager, 'pnpm');
assert.strictEqual(next.installCommand, 'pnpm install --frozen-lockfile');
assert.strictEqual(next.buildCommand, 'pnpm run build');
assert.strictEqual(next.startCommand, 'pnpm run start');
assert.strictEqual(next.nodeVersion, '20.11');
assert.strictEqual(next.port, 3000);

const nextNoScripts = detectFromFiles({ 'package.json': JSON.stringify({ dependencies: { next: '15' } }), 'package-lock.json': '' });
assert.strictEqual(nextNoScripts.installCommand, 'npm ci --no-audit --no-fund');
assert.strictEqual(nextNoScripts.startCommand, 'next start -H 127.0.0.1 -p $PORT');

const nextExport = detectFromFiles({
  'package.json': JSON.stringify({ dependencies: { next: '15' } }),
  'next.config.mjs': "export default { output: 'export' }",
});
assert.strictEqual(nextExport.type, 'STATIC');
assert.strictEqual(nextExport.outputDir, 'out');

const vite = detectFromFiles({ 'package.json': JSON.stringify({ devDependencies: { vite: '5' }, scripts: { build: 'vite build' } }), 'yarn.lock': '' });
assert.strictEqual(vite.type, 'STATIC');
assert.strictEqual(vite.buildCommand, 'yarn run build');

const express = detectFromFiles({ 'package.json': JSON.stringify({ dependencies: { express: '4' }, main: 'server.js' }) });
assert.strictEqual(express.framework, 'express');
assert.strictEqual(express.startCommand, 'node index.js');

const php = detectFromFiles({ 'index.php': '<?php' });
assert.strictEqual(php.type, 'PHP');
assert.strictEqual(php.installCommand, '');
assert.strictEqual(php.outputDir, '.');

const laravel = detectFromFiles({
  'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11' } }),
  'package.json': JSON.stringify({ devDependencies: { vite: '5' }, scripts: { build: 'vite build' } }),
  'package-lock.json': '',
});
assert.strictEqual(laravel.type, 'PHP');
assert.strictEqual(laravel.framework, 'laravel');
assert.strictEqual(laravel.outputDir, 'public');
assert.ok(laravel.installCommand.startsWith('composer install'));
assert.strictEqual(laravel.buildCommand, 'npm ci --no-audit --no-fund && npm run build');

const html = detectFromFiles({ 'index.html': '<html>' });
assert.strictEqual(html.type, 'STATIC');

assert.strictEqual(detectFromFiles({ 'package.json': '{not json' }).framework, 'node');

const pre = nvmPreamble('20.11', true).join(NL);
assert.ok(pre.includes("nvm install '20.11'"));
assert.ok(pre.includes("nvm use '20.11'"));
assert.ok(!nvmPreamble('20.11', false).join(NL).includes('nvm install'));
assert.ok(nvmPreamble('>=18', true).join(NL).includes('nvm use default'));
assert.ok(nvmPreamble(null, false).join(NL).includes('nvm use default'));
assert.ok(nvmPreamble('lts/*', false).join(NL).includes("nvm use 'lts/*'"));

// ls-remote: default branch from the HEAD symref, listed first; tags ignored
const remote = parseLsRemote(
  ['ref: refs/heads/master\tHEAD', 'aaa\tHEAD', 'bbb\trefs/heads/dev', 'aaa\trefs/heads/master', 'ccc\trefs/tags/v1', 'ddd\trefs/heads/feat/x'].join(NL)
);
assert.strictEqual(remote.defaultBranch, 'master');
assert.deepStrictEqual(remote.branches, ['master', 'dev', 'feat/x']);
assert.strictEqual(parseLsRemote('').defaultBranch, null);

// .env files: example keys prefill the form, .env.production is listed, a committed .env is flagged
const env = detectFromFiles({
  'package.json': JSON.stringify({ dependencies: { next: '16' } }),
  '.env.example': [
    '# database',
    'DATABASE_URL=',
    'export AUTH_SECRET=""',
    'PORT=3000 # default',
    "GREETING='hello # not a comment'",
    'MULTI="line1\\nline2"',
    'KEY_WITH_SPACES = spaced value ',
    'bad-key=x',
  ].join(NL),
  '.env.production': 'NEXT_PUBLIC_SITE=https://x.id',
  '.env': '',
}).env;
assert.strictEqual(env.example?.file, '.env.example');
assert.deepStrictEqual(env.example?.vars, [
  { key: 'DATABASE_URL', value: '' },
  { key: 'AUTH_SECRET', value: '' },
  { key: 'PORT', value: '3000' },
  { key: 'GREETING', value: 'hello # not a comment' },
  { key: 'MULTI', value: 'line1' + NL + 'line2' },
  { key: 'KEY_WITH_SPACES', value: 'spaced value' },
]);
assert.deepStrictEqual(env.production, ['NEXT_PUBLIC_SITE']);
assert.deepStrictEqual(env.committed, ['.env']);
assert.deepStrictEqual(detectFromFiles({ 'index.html': '' }).env, { example: null, production: [], committed: [] });
// a real multi-line value in double quotes
assert.deepStrictEqual(parseEnvFile('CERT="-----BEGIN' + NL + 'abc' + NL + '-----END"' + NL + 'NEXT=1'), [
  ['CERT', '-----BEGIN' + NL + 'abc' + NL + '-----END'],
  ['NEXT', '1'],
]);
// secrets are never kept, lockfiles only by presence
assert.ok(presenceOnly('.env') && presenceOnly('.env.local') && presenceOnly('pnpm-lock.yaml') && presenceOnly('bun.lockb'));
assert.ok(!presenceOnly('.env.example') && !presenceOnly('package.json'));

console.log('projectDetect: ok');
