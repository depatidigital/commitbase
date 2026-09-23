/**
 * Self-check for how a compose stack is handed a database on its own node:
 * npx tsx src/routes/databases.check.ts
 */
import assert from 'assert';
import { forContainers } from './databases';

const local = forContainers({ host: '127.0.0.1', url: 'postgresql://u:p@127.0.0.1:5432/ckan' });
assert.strictEqual(local.host, 'host.containers.internal');
assert.strictEqual(local.url, 'postgresql://u:p@host.containers.internal:5432/ckan');
// localhost too, without a port (an "@" in a password is %40 in the URL, so it never matches)
assert.strictEqual(forContainers({ host: 'localhost', url: 'postgresql://u:p@localhost/db' }).url, 'postgresql://u:p@host.containers.internal/db');
// another node's address is already reachable from a container
const remote = { host: '10.0.0.5', url: 'postgresql://u:p@10.0.0.5:5432/ckan' };
assert.deepStrictEqual(forContainers(remote), remote);

console.log('databases: ok');
process.exit(0);
