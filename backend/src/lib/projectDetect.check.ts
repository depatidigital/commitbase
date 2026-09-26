import assert from 'assert';
import { appFoldersOf, foldersOf, isEnvFile, detectFromFiles,nvmPreamble, parseLsRemote, parseEnvFile, preDeployOf, presenceOnly, withRootFiles, pnpmAllowBuildsInFolder, PNPM_ALLOW_BUILDS_ENV } from './projectDetect';

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
assert.strictEqual(next.installCommand, 'pnpm install --frozen-lockfile --config.dangerouslyAllowAllBuilds=true');
assert.strictEqual(next.buildCommand, 'pnpm run build');
// a start script that is only `next start` runs as Next itself: loopback, the platform's port
const NEXT_START = 'node ./node_modules/next/dist/bin/next start -H 127.0.0.1 -p $PORT';
assert.strictEqual(next.startCommand, NEXT_START);
assert.deepStrictEqual(next.warnings, []);
assert.strictEqual(next.nodeVersion, '20.11');
assert.strictEqual(next.port, 3000);

const nextNoScripts = detectFromFiles({ 'package.json': JSON.stringify({ dependencies: { next: '15' } }), 'package-lock.json': '' });
// npm's lockfile: pnpm all the same, importing it — npm only when the app says so
assert.strictEqual(nextNoScripts.installCommand, 'pnpm import && pnpm install --frozen-lockfile --config.dangerouslyAllowAllBuilds=true');
assert.strictEqual(nextNoScripts.startCommand, NEXT_START);

// a script that does more is kept — and said about when it pins a port or binds everywhere
const nextStart = (start: string) =>
  detectFromFiles({ 'package.json': JSON.stringify({ dependencies: { next: '16' }, scripts: { start } }), 'pnpm-lock.yaml': '' });
const migrating = nextStart('prisma migrate deploy && next start');
assert.strictEqual(migrating.startCommand, 'npm start');
assert.deepStrictEqual(migrating.warnings, [{ code: 'start-binds-all' }]);
assert.deepStrictEqual(nextStart('next start -p 3000').warnings, [{ code: 'start-fixed-port', port: '3000' }, { code: 'start-binds-all' }]);
assert.deepStrictEqual(nextStart('next start --port=4000 -H 127.0.0.1').warnings, [{ code: 'start-fixed-port', port: '4000' }]);
assert.deepStrictEqual(nextStart('node server.js').warnings, [], 'a custom server is not next start');
// only Next: other frameworks read PORT/HOST themselves
assert.deepStrictEqual(detectFromFiles({ 'package.json': JSON.stringify({ dependencies: { express: '4' }, scripts: { start: 'node index.js -p 3000' } }) }).warnings, []);

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
assert.strictEqual(laravel.buildCommand, 'pnpm import && pnpm install --frozen-lockfile --config.dangerouslyAllowAllBuilds=true && pnpm run build');

const html = detectFromFiles({ 'index.html': '<html>' });
assert.strictEqual(html.type, 'STATIC');

assert.strictEqual(detectFromFiles({ 'package.json': '{not json' }).framework, 'node');

// vite hoisted to a workspace root, no build script: the config alone makes it a Vite site
const viteByConfig = detectFromFiles({ 'package.json': JSON.stringify({ dependencies: { react: '19' } }), 'vite.config.ts': '', 'index.html': '' });
assert.strictEqual(viteByConfig.framework, 'vite');
assert.strictEqual(viteByConfig.outputDir, 'dist');
assert.strictEqual(viteByConfig.buildCommand, 'npx --no-install vite build');

// a Vite folder with no package.json of its own (the root's): still Vite, not Static HTML
const viteFolder = detectFromFiles({ 'vite.config.ts': '', 'index.html': '', 'package-lock.json': '' });
assert.strictEqual(viteFolder.framework, 'vite');
assert.strictEqual(viteFolder.outputDir, 'dist');

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
assert.deepStrictEqual(remote.heads, { dev: 'bbb', master: 'aaa', 'feat/x': 'ddd' });
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
assert.deepStrictEqual(detectFromFiles({ 'index.html': '' }).env, { needsDatabase: false, example: null, production: [], committed: [] });
// an ORM or SQL client means the app wants a database
assert.ok(detectFromFiles({ 'package.json': JSON.stringify({ dependencies: { '@prisma/client': '7' } }) }).env.needsDatabase);
assert.ok(!detectFromFiles({ 'package.json': JSON.stringify({ dependencies: { next: '16' } }) }).env.needsDatabase);
// a real multi-line value in double quotes
assert.deepStrictEqual(parseEnvFile('CERT="-----BEGIN' + NL + 'abc' + NL + '-----END"' + NL + 'NEXT=1'), [
  ['CERT', '-----BEGIN' + NL + 'abc' + NL + '-----END'],
  ['NEXT', '1'],
]);
// secrets are never kept, lockfiles only by presence
assert.ok(presenceOnly('.env') && presenceOnly('.env.local') && presenceOnly('pnpm-lock.yaml') && presenceOnly('bun.lockb'));
assert.ok(!presenceOnly('.env.example') && !presenceOnly('package.json'));

// Prisma: migrations applied before the release goes live, with the project's own runner
const prismaPkg = { 'package.json': JSON.stringify({ dependencies: { '@prisma/client': '6.0.0', next: '15.0.0' }, devDependencies: { prisma: '6.0.0' } }) };
assert.strictEqual(preDeployOf(prismaPkg, 'pnpm'), 'pnpm prisma migrate deploy');
assert.strictEqual(preDeployOf(prismaPkg, 'npm'), 'npx prisma migrate deploy');
assert.strictEqual(preDeployOf(prismaPkg, 'bun', true), 'bunx prisma migrate deploy');
// no prisma/migrations in the repo: the schema is pushed instead
assert.strictEqual(preDeployOf(prismaPkg, 'yarn', false), 'yarn prisma db push');
assert.strictEqual(preDeployOf({ 'package.json': JSON.stringify({ dependencies: { next: '15' } }) }, 'pnpm'), null);
assert.strictEqual(detectFromFiles({ ...prismaPkg, 'pnpm-lock.yaml': '' }).preDeployCommand, 'pnpm prisma migrate deploy');
assert.strictEqual(next.preDeployCommand, null);
// the client is generated before the build, not left to the install
assert.strictEqual(detectFromFiles({ ...prismaPkg, 'pnpm-lock.yaml': '' }).generateCommand, 'pnpm prisma generate');
assert.strictEqual(next.generateCommand, null);

// package.json's packageManager first, then text lockfiles; bun.lockb (binary, pre-1.2) only when it is alone
const pmOf = (files: Record<string, string>) => detectFromFiles({ 'package.json': JSON.stringify({ dependencies: { vite: '5' } }), ...files }).packageManager;
assert.strictEqual(pmOf({ 'bun.lockb': '', 'package-lock.json': '' }), 'pnpm', 'a leftover bun.lockb beside package-lock.json');
assert.strictEqual(pmOf({ 'bun.lock': '', 'package-lock.json': '' }), 'bun');
assert.strictEqual(pmOf({ 'bun.lockb': '' }), 'bun');
assert.strictEqual(pmOf({ 'bun.lockb': '', 'yarn.lock': '' }), 'yarn');
assert.strictEqual(
  detectFromFiles({ 'package.json': JSON.stringify({ packageManager: 'npm@10.0.0' }), 'yarn.lock': '' }).packageManager,
  'pnpm',
  'the declared manager wins over a lockfile; npm itself is pnpm unless the app chose npm',
);

// Monorepo: a workspace package inherits the root's lockfile, node version and
// packageManager, and installs at the root
const webPkg = { 'package.json': JSON.stringify({ dependencies: { next: '15.0.0' }, scripts: { build: 'next build' } }) };
const workspaceRoot = {
  'package.json': JSON.stringify({ private: true, packageManager: 'pnpm@9.1.0' }),
  'pnpm-lock.yaml': '',
  '.nvmrc': '20' + NL,
};
const inWorkspace = withRootFiles(webPkg, workspaceRoot);
assert.strictEqual(inWorkspace.installAtRoot, true);
const web = detectFromFiles(inWorkspace.files);
assert.strictEqual(web.packageManager, 'pnpm');
assert.strictEqual(web.installCommand, 'pnpm install --frozen-lockfile --config.dangerouslyAllowAllBuilds=true');
assert.strictEqual(web.nodeVersion, '20');
// packageManager alone (yarn berry repos without a lockfile yet) still names the manager
assert.strictEqual(detectFromFiles(withRootFiles(webPkg, { 'package.json': JSON.stringify({ packageManager: 'yarn@4.0.0' }) }).files).packageManager, 'yarn');
// a folder with its own lockfile is its own project: installs there, keeps its manager
const standalone = withRootFiles({ ...webPkg, 'package-lock.json': '' }, workspaceRoot);
assert.strictEqual(standalone.installAtRoot, false);
assert.strictEqual(standalone.files['pnpm-lock.yaml'], undefined);
assert.strictEqual(detectFromFiles(standalone.files).installCommand, 'pnpm import && pnpm install --frozen-lockfile --config.dangerouslyAllowAllBuilds=true');
assert.strictEqual(detectFromFiles(standalone.files, undefined, 'npm').installCommand, 'npm ci --no-audit --no-fund');
// its own packageManager wins over the root's
assert.strictEqual(
  JSON.parse(withRootFiles({ 'package.json': JSON.stringify({ packageManager: 'bun@1.1.0' }) }, workspaceRoot).files['package.json']!).packageManager,
  'bun@1.1.0',
);
// nothing to inherit: unchanged, installs in the folder
assert.deepStrictEqual(withRootFiles(webPkg, {}), { files: webPkg, installAtRoot: false });

// The apps of a repository: folders with an app's marker, not a workspace root,
// not a folder inside an app, not dependencies or build output
const pkgs: Record<string, any> = {
  '': { private: true, workspaces: ['apps/*'], scripts: { build: 'turbo build' } },
  'apps/web': { dependencies: { next: '15' }, scripts: { build: 'next build' } },
  'apps/api': { scripts: { start: 'node index.js' } },
  'packages/config': { name: 'config' },
};
const tree = [
  'package.json',
  'apps/web/package.json',
  'apps/web/public/index.html',
  'apps/api/package.json',
  'apps/admin/composer.json',
  'packages/config/package.json',
  'docs/index.html',
  'node_modules/x/package.json',
  'apps/web/.next/index.html',
  'a/b/c/d/e/index.html',
  'test/fixtures/blog/index.html',
  'examples/search/public/index.html',
];
assert.deepStrictEqual(appFoldersOf(tree, (dir) => pkgs[dir] ?? null), ['apps/admin', 'apps/api', 'apps/web', 'docs']);
// a pnpm workspace root is not an app either; a plain repo is its root alone
assert.deepStrictEqual(appFoldersOf(['package.json', 'pnpm-workspace.yaml', 'apps/api/package.json'], (dir) => (dir ? pkgs['apps/api'] : { scripts: { build: 'x' } })), ['apps/api']);
assert.deepStrictEqual(appFoldersOf(['package.json', 'examples/demo/package.json'], () => ({ scripts: { dev: 'vite' } })), ['']);
// a root that runs the others (pm2) is a draft beside them, not above them
assert.deepStrictEqual(
  appFoldersOf(['package.json', 'backend/package.json', 'frontend/package.json', 'frontend/index.html', 'frontend/src/index.html'], (dir) =>
    dir === 'frontend/src' ? null : { scripts: { start: 'x' } },
  ),
  ['', 'backend', 'frontend'],
);

// the permission pnpm 11+ reads from the install folder, idempotent and quotable
assert.match(pnpmAllowBuildsInFolder(), /^grep -qs dangerouslyAllowAllBuilds pnpm-workspace\.yaml \|\| printf /);
assert.ok(pnpmAllowBuildsInFolder('/srv/app').includes('"/srv/app/pnpm-workspace.yaml"'));
assert.strictEqual(PNPM_ALLOW_BUILDS_ENV.pnpm_config_dangerously_allow_all_builds, 'true');

console.log('projectDetect: ok');

// a chosen pnpm over npm's lockfile imports it first
const chosenPnpm = detectFromFiles({ 'package.json': JSON.stringify({ dependencies: { express: '4' } }), 'package-lock.json': '' }, undefined, 'pnpm');
assert.strictEqual(chosenPnpm.packageManager, 'pnpm');
assert.strictEqual(chosenPnpm.installCommand, 'pnpm import && pnpm install --frozen-lockfile --config.dangerouslyAllowAllBuilds=true');

// a build that is tsc runs emit-only: a type error is not a failed deploy
import { buildOf } from './projectDetect';
assert.strictEqual(buildOf('pnpm', 'tsc'), 'pnpm tsc --noCheck');
assert.strictEqual(buildOf('npm', 'tsc -b && vite build'), 'npx tsc -b --noCheck && npx vite build');
assert.strictEqual(buildOf('pnpm', 'tsc --build && vite build'), 'pnpm tsc -b --noCheck && pnpm vite build');
assert.strictEqual(buildOf('pnpm', 'next build'), 'pnpm run build');
assert.strictEqual(buildOf('pnpm', 'tsc && node scripts/x.js && vite build'), 'pnpm run build');

// ---------------------------------------------------------------- Python
import { djangoProjectOf, pythonDeps } from './projectDetect';

// a stdlib-only script: nothing to install, run as itself
const plain = detectFromFiles({ 'app.py': '' });
assert.strictEqual(plain.type, 'PYTHON');
assert.strictEqual(plain.framework, 'python');
assert.strictEqual(plain.installCommand, '');
assert.strictEqual(plain.startCommand, 'python app.py');
assert.strictEqual(plain.port, 8000);

// Flask: gunicorn in front of it, installed because the repo does not ship it
const flask = detectFromFiles({ 'requirements.txt': 'Flask==3.0.0\nrequests\n', 'app.py': '' });
assert.strictEqual(flask.framework, 'flask');
assert.strictEqual(flask.installCommand, 'pip install -r requirements.txt && pip install gunicorn');
assert.strictEqual(flask.startCommand, 'gunicorn app:app --bind 127.0.0.1:$PORT');

// a repo that ships its own server is not given a second one
const withServer = detectFromFiles({ 'requirements.txt': 'flask\ngunicorn==21.2\n', 'app.py': '' });
assert.strictEqual(withServer.installCommand, 'pip install -r requirements.txt');

// FastAPI: uvicorn, on the module the entry file names
const fastapi = detectFromFiles({ 'requirements.txt': 'fastapi\n', 'main.py': '' });
assert.strictEqual(fastapi.framework, 'fastapi');
assert.strictEqual(fastapi.startCommand, 'uvicorn main:app --host 127.0.0.1 --port $PORT');
assert.strictEqual(fastapi.installCommand, 'pip install -r requirements.txt && pip install uvicorn');

// Django: the wsgi module comes from manage.py, and migrations are the pre-deploy step
const django = detectFromFiles({
  'manage.py': "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'mysite.settings')",
  'requirements.txt': 'Django==5.0\n',
});
assert.strictEqual(django.framework, 'django');
assert.strictEqual(django.startCommand, 'gunicorn mysite.wsgi:application --bind 127.0.0.1:$PORT');
assert.strictEqual(django.preDeployCommand, 'python manage.py migrate --noinput');
assert.strictEqual(djangoProjectOf(undefined), null);

// a Python app that builds its own assets is not a Node app
const hybrid = detectFromFiles({
  'requirements.txt': 'fastapi\n',
  'main.py': '',
  'package.json': JSON.stringify({ dependencies: { vite: '5' }, scripts: { build: 'vite build' } }),
});
assert.strictEqual(hybrid.type, 'PYTHON');

// pyproject.toml is read for its dependencies too; names normalise
const pyproject = detectFromFiles({ 'pyproject.toml': '[project]\nname = "svc"\ndependencies = ["FastAPI>=0.110", "httpx"]\n', 'main.py': '' });
assert.strictEqual(pyproject.framework, 'fastapi');
assert.strictEqual(pyproject.installCommand, 'pip install . && pip install uvicorn');
assert.ok(pythonDeps({ 'requirements.txt': 'Flask_SQLAlchemy==1.0' }).has('flask-sqlalchemy'));

// an entry file is known from the tree, never downloaded
assert.ok(presenceOnly('app.py'));
// a folder with requirements.txt and no package.json is an app of its own
assert.deepStrictEqual(appFoldersOf(['requirements.txt', 'web/package.json'], () => ({ scripts: { build: 'vite build' } })), ['', 'web']);

console.log('projectDetect: python ok');

// a repository whose compose file is the deployment: no package.json, no
// composer.json — nothing else to build it as. CKAN keeps its in compose/.
const stack = detectFromFiles({ 'compose/docker-compose.yml': 'services:\n  ckan:\n    build: .\n' });
assert.strictEqual(stack.type, 'COMPOSE');
assert.strictEqual(stack.composeFile, 'compose/docker-compose.yml');
assert.strictEqual(stack.buildCommand, null);

// a Node app that ships a compose file to run Postgres while developing is
// still a Node app — the compose file is not what gets deployed
const nodeWithCompose = detectFromFiles({
  'docker-compose.yml': 'services:\n  db:\n    image: postgres\n',
  'package.json': JSON.stringify({ dependencies: { next: '14' }, scripts: { build: 'next build' } }),
});
assert.strictEqual(nodeWithCompose.type, 'NODEJS');
assert.strictEqual(nodeWithCompose.framework, 'nextjs');

// the same for PHP: composer.json decides, and the operator picks COMPOSE by hand
const phpWithCompose = detectFromFiles({ 'docker-compose.yml': 'services: {}\n', 'composer.json': '{}' });
assert.strictEqual(phpWithCompose.type, 'PHP');

console.log('projectDetect: compose ok');

// folder picker: every folder up to 3 deep, dependencies and dot-folders left out
assert.deepStrictEqual(
  foldersOf(['package.json', 'apps/web/src/pages/index.tsx', 'node_modules/x/index.js', '.github/workflows/ci.yml', 'compose/docker-compose.yml']),
  ['apps', 'apps/web', 'apps/web/src', 'compose'],
);

// env editor tabs: files an app reads, never their examples or look-alikes
for (const name of ['.env', '.ckan-env', '.env.local', '.env.production', 'app.env', 'prod_env']) assert.ok(isEnvFile(name), name);
for (const name of ['.env.example', '.env.sample', '.env.template', '.env.dist', 'environment.ts', 'docker-compose.yml', 'venv', 'envs', 'Dockerfile', '.envrc']) {
  assert.ok(!isEnvFile(name), name);
}
