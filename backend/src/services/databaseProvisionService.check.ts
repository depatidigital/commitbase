import assert from 'node:assert/strict';
import { ProvisionError, accountName, connectionUrl, databaseName, hostForApp, loginName, ownerRoleName } from './databaseProvisionService';

// login names: dashes become underscores, and MySQL's 32-char cap is kept
assert.equal(loginName('acme', 'POSTGRESQL'), 'org_acme');
assert.equal(loginName('yayasan-pesona', 'MYSQL'), 'org_yayasan_pesona');
const long = 'yayasan-pesona-kebaikan-indonesia-raya-01';
assert.ok(loginName(long, 'MYSQL').length <= 32);
assert.ok(loginName(long, 'POSTGRESQL').length <= 63);
assert.notEqual(loginName(long, 'MYSQL'), loginName('yayasan-pesona-kebaikan-indonesia-raya-02', 'MYSQL'));
assert.match(loginName(long, 'MYSQL'), /^[a-z0-9_]+$/);

// database names: org prefix, safe characters only, engine length limits
assert.equal(databaseName('acme-co', 'crm', 'POSTGRESQL'), 'acme_co_crm');
assert.throws(() => databaseName('acme', 'Bad-Name', 'POSTGRESQL'), ProvisionError);
assert.throws(() => databaseName('acme', '1crm', 'MYSQL'), ProvisionError);
assert.throws(() => databaseName('acme', 'x"; DROP DATABASE y; --', 'POSTGRESQL'), ProvisionError);
assert.throws(() => databaseName('a'.repeat(40), 'b'.repeat(30), 'POSTGRESQL'), ProvisionError);

// connection URLs: TLS on a managed server, the password encoded when present
const node = { engine: 'POSTGRESQL', mode: 'TUNNEL', appHost: '10.0.0.5', port: 5432 } as const;
assert.equal(connectionUrl(node, 'org_acme', 'acme_crm'), 'postgresql://org_acme@10.0.0.5:5432/acme_crm');
assert.equal(
  connectionUrl({ ...node, engine: 'MYSQL', mode: 'DIRECT', appHost: 'db.example.com', port: 3306 }, 'org_acme', 'acme_crm', 'p/w+'),
  'mysql://org_acme:p%2Fw%2B@db.example.com:3306/acme_crm?ssl-mode=REQUIRED',
);

// named logins: prefixed with the org slug, held to identifier rules and the engine's cap
assert.equal(accountName('depati', 'umojati', 'POSTGRESQL'), 'depati_umojati');
assert.equal(accountName('yayasan-pesona', 'shop', 'MYSQL'), 'yayasan_pesona_shop');
assert.throws(() => accountName('acme', 'Shop', 'POSTGRESQL'), ProvisionError);
assert.throws(() => accountName('acme', '1shop', 'POSTGRESQL'), ProvisionError);
assert.throws(() => accountName('acme', 'x; DROP ROLE admin', 'POSTGRESQL'), ProvisionError);
assert.throws(() => accountName('yayasan-pesona-kebaikan', 'aplikasi_utama', 'MYSQL'), ProvisionError);

// the database's owner role: <db>_owner, unique and within PostgreSQL's 63
assert.equal(ownerRoleName('depati_umojati'), 'depati_umojati_owner');
const longDb = 'a'.repeat(63);
assert.ok(ownerRoleName(longDb).length <= 63);
assert.notEqual(ownerRoleName(longDb), ownerRoleName('a'.repeat(62) + 'b'));
assert.match(ownerRoleName(longDb), /_owner$/);

// where an app reaches a tunnelled server: loopback on its node, an outside address from elsewhere
const tunnelled = { mode: 'TUNNEL', host: '127.0.0.1', appHost: '127.0.0.1', serverId: 'node-a', server: { publicIp: '103.1.2.3' } };
assert.equal(hostForApp(tunnelled, 'node-a'), '127.0.0.1');
assert.equal(hostForApp(tunnelled, 'node-b'), '103.1.2.3');
assert.equal(hostForApp({ ...tunnelled, appHost: '10.0.0.5' }, 'node-b'), '10.0.0.5');
assert.equal(hostForApp({ ...tunnelled, appHost: 'localhost' }, 'node-b'), '103.1.2.3');
// a managed service is the same address from everywhere
assert.equal(hostForApp({ mode: 'DIRECT', host: 'db.example.com', appHost: 'db.example.com', serverId: null }, 'node-a'), 'db.example.com');

console.log('databaseProvisionService: names + connectionUrl + logins + hostForApp OK');
