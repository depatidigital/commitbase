/**
 * Self-check for what a compose stack is named, published on and configured
 * with: npx tsx src/services/composeService.check.ts
 */
import assert from 'assert';
import {
  composeArgv,
  composeEnvFilesOf,
  composeFilesOf,
  overrideYaml,
  projectName,
  quoteEnv,
  readPsStatus,
  DEFAULT_COMPOSE_FILE,
  DEFAULT_ENV_FILE,
  OVERRIDE_FILE,
} from './composeService';

// The project name comes from the app, never from the directory compose runs
// in. This is the one that loses data if it regresses: a name derived from the
// release directory would be a new project, and a new set of empty volumes,
// on every single deploy.
const release1 = projectName('acme', 'clx123abc');
const release2 = projectName('acme', 'clx123abc');
assert.strictEqual(release1, release2);
assert.strictEqual(release1, 'cb-acme-clx123abc');

// two apps of one org are two stacks; one app on two nodes is one
assert.notStrictEqual(projectName('acme', 'app1'), projectName('acme', 'app2'));
assert.notStrictEqual(projectName('acme', 'app1'), projectName('other', 'app1'));

// compose rejects an upper-case project name
assert.strictEqual(projectName('acme', 'CLX123ABC'), 'cb-acme-clx123abc');

// unset means the conventional file, not an empty command line
assert.deepStrictEqual(composeFilesOf({ composeFiles: [] }), [DEFAULT_COMPOSE_FILE]);
assert.deepStrictEqual(composeEnvFilesOf({ composeEnvFiles: [] }), [DEFAULT_ENV_FILE]);
// CKAN reads two env files; ILDIS ships its cron in a second compose file
assert.deepStrictEqual(composeEnvFilesOf({ composeEnvFiles: ['.env', '.ckan-env'] }), ['.env', '.ckan-env']);

// the files keep the order they were given — compose merges later ones over earlier
const argv = composeArgv('cb-acme-app1', ['docker-compose.yml', 'docker-compose.cron.yml', OVERRIDE_FILE], ['up', '-d']);
assert.deepStrictEqual(argv, [
  'cb-compose',
  '--project-name',
  'cb-acme-app1',
  '--project-directory',
  '.',
  '-f',
  'docker-compose.yml',
  '-f',
  'docker-compose.cron.yml',
  '-f',
  OVERRIDE_FILE,
  'up',
  '-d',
]);
// the override is read last, so its ports win
assert.strictEqual(argv[argv.length - 3], OVERRIDE_FILE);

// the published port is rebound to loopback at the port the platform allocated:
// a stack's own 5000 or 8080 would collide with the next stack on the node, and
// a published database would be on every interface
const override = overrideYaml('ckan', 20001, 5000);
assert.match(override, /^\s+- "127\.0\.0\.1:20001:5000"$/m);
assert.strictEqual(override.includes('  ckan:'), true);
// nothing else is published from here
assert.strictEqual((override.match(/127\.0\.0\.1/g) || []).length, 1);

// env values are quoted for dotenv, not for a shell: the four characters that
// mean something inside double quotes are escaped, and a newline survives
assert.strictEqual(quoteEnv('plain'), '"plain"');
assert.strictEqual(quoteEnv('a"b'), '"a\\"b"');
assert.strictEqual(quoteEnv('pa$$word'), '"pa\\$\\$word"');
assert.strictEqual(quoteEnv('back\\slash'), '"back\\\\slash"');
assert.strictEqual(quoteEnv('a`b'), '"a\\`b"');
assert.strictEqual(quoteEnv('one\ntwo'), '"one\\ntwo"');

// compose v2 prints a JSON array or one object per line, depending on version
assert.strictEqual(readPsStatus('[{"Service":"ckan","State":"running"}]'), 'RUNNING');
assert.strictEqual(readPsStatus('{"Service":"ckan","State":"running"}\n{"Service":"db","State":"exited"}'), 'RUNNING');
// a one-shot that exited cleanly beside a running service is not a stopped stack
assert.strictEqual(readPsStatus('[{"State":"exited"},{"State":"running"}]'), 'RUNNING');
// mid-restart counts as running, as it does for a unit
assert.strictEqual(readPsStatus('[{"State":"restarting"}]'), 'RUNNING');
// nothing up, nothing at all, or output we cannot read: stopped, never a throw
assert.strictEqual(readPsStatus('[{"State":"exited"}]'), 'STOPPED');
assert.strictEqual(readPsStatus('[]'), 'STOPPED');
assert.strictEqual(readPsStatus(''), 'STOPPED');
assert.strictEqual(readPsStatus('not json'), 'STOPPED');

console.log('composeService: ok');
