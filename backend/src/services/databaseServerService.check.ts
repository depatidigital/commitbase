import assert from 'node:assert/strict';
import { mysqlRights } from './databaseServerService';

// a dedicated provisioning admin: exactly what is needed, not a superuser
const scoped = mysqlRights([
  'GRANT CREATE, DROP, CREATE USER ON *.* TO `cb_admin`@`%` WITH GRANT OPTION',
  'GRANT SELECT ON `mysql`.* TO `cb_admin`@`%`',
]);
assert.deepEqual(scoped.missing, []);
assert.equal(scoped.superuser, false);

// root-style: everything, flagged so the UI can warn
const root = mysqlRights(['GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost` WITH GRANT OPTION']);
assert.deepEqual(root.missing, []);
assert.equal(root.superuser, true);

// an app user: nothing global, so everything is missing
const app = mysqlRights(['GRANT USAGE ON *.* TO `app`@`%`', 'GRANT ALL PRIVILEGES ON `app_db`.* TO `app`@`%`']);
assert.deepEqual(app.missing, ['CREATE USER', 'CREATE', 'DROP', 'GRANT OPTION']);
assert.equal(app.superuser, false);

// a database-level ALL must not count as global
const dbAll = mysqlRights(['GRANT ALL PRIVILEGES ON `shop`.* TO `x`@`%` WITH GRANT OPTION']);
assert.equal(dbAll.superuser, false);
assert.ok(dbAll.missing.includes('CREATE USER'));

console.log('databaseServerService: mysqlRights OK');
