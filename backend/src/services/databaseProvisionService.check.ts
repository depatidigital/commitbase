import assert from 'node:assert/strict';
import { ProvisionError, connectionUrl, databaseName, loginName } from './databaseProvisionService';

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

console.log('databaseProvisionService: names + connectionUrl OK');
