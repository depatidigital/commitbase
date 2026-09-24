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
  portRules,
  projectName,
  quoteEnv,
  readPsStatus,
  servicesOf,
  stuckContainers,
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

// Every published port goes to loopback: the serving one at the port the
// platform allocated, the rest at their own host port. CKAN's compose file
// publishes ckan on 0.0.0.0:5000 and datapusher on 8000 — both open to the
// internet otherwise, and 5000 colliding with the next stack on the node.
const ckanConfig = {
  services: {
    ckan: { ports: [{ mode: 'ingress', host_ip: '0.0.0.0', target: 5000, published: '5000', protocol: 'tcp' }] },
    datapusher: { ports: [{ mode: 'ingress', target: 8000, published: '8000', protocol: 'tcp' }] },
    solr: {},
    redis: { image: 'redis:6' },
  },
};
const rules = portRules(ckanConfig, { service: 'ckan', hostPort: 20001, containerPort: 5000 });
assert.deepStrictEqual(rules, [
  { service: 'ckan', ports: ['127.0.0.1:20001:5000'] },
  { service: 'datapusher', ports: ['127.0.0.1:8000:8000'] },
]);
// compose merges a later file's ports into the list instead of replacing it:
// without !override the stack would keep 0.0.0.0:5000 beside the loopback one
const override = overrideYaml(rules);
assert.strictEqual((override.match(/ports: !override/g) || []).length, 2);
assert.match(override, /^\s+- "127\.0\.0\.1:20001:5000"$/m);
assert.ok(!override.includes('0.0.0.0'));
// compose config unreadable: the serving port is still rebound on its own
assert.deepStrictEqual(portRules(null, { service: 'ckan', hostPort: 20001, containerPort: 5000 }), [
  { service: 'ckan', ports: ['127.0.0.1:20001:5000'] },
]);
// udp keeps its protocol
assert.deepStrictEqual(portRules({ services: { dns: { ports: [{ target: 53, published: '5353', protocol: 'udp' }] } } }, { service: 'web', hostPort: 1, containerPort: 2 })[1], {
  service: 'dns',
  ports: ['127.0.0.1:5353:53/udp'],
});

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

// the preview: build or image, published and bare ports, depends_on by name
assert.deepStrictEqual(
  servicesOf({
    services: {
      ckan: {
        build: { context: '.' },
        ports: [{ target: 5000, published: '5000' }],
        depends_on: { db: {}, redis: {} },
        environment: { CKAN_SITE_URL: 'https://x', EMPTY: null },
        env_file: [{ path: '/srv/app/compose/.ckan-env', required: true }],
      },
      redis: { image: 'redis:6.0.14' },
      solr: { image: 'x', build: { context: '.' }, ports: [{ target: 8983 }] },
    },
  }),
  [
    {
      name: 'ckan',
      image: null,
      build: true,
      ports: ['5000:5000'],
      dependsOn: ['db', 'redis'],
      environment: { CKAN_SITE_URL: 'https://x', EMPTY: '' },
      envFiles: ['.ckan-env'],
    },
    { name: 'redis', image: 'redis:6.0.14', build: false, ports: [], dependsOn: [], environment: {}, envFiles: [] },
    { name: 'solr', image: null, build: true, ports: ['8983'], dependsOn: [], environment: {}, envFiles: [] },
  ],
);
assert.deepStrictEqual(servicesOf(null), []);

// a recreate Podman refused: the old container's id, once however often compose says it
const id = 'd2df8015efcce8d9a09fb593add9a8aa8e0f859188c349e8576e428b6dd4ec14';
const refused = `Error response from daemon: cannot remove container ${id} as it is running - running or paused containers cannot be removed without force: container state improper`;
assert.deepStrictEqual(stuckContainers(`${refused}
${refused}`), [id]);
assert.deepStrictEqual(stuckContainers('Error response from daemon: no such container'), []);

console.log('composeService: ok');
