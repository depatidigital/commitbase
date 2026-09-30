import assert from 'node:assert';
import { SCRIPT_NAME } from './deployment';

// names package.json really uses pass
for (const name of ['dev', 'seed:products', 'backfill:explanation-free-tier', 'mirror:soal121', 'lint:fix', 'db.push', 'a_b']) assert.ok(SCRIPT_NAME.test(name), name);
// anything a shell would read as more than a name does not
for (const name of ['', 'a b', 'a;rm -rf /', 'a&&b', '$(id)', '`id`', 'a|b', 'a>b', "a'b", 'a"b', 'a\nb', '../x', 'x'.repeat(81)]) assert.ok(!SCRIPT_NAME.test(name), JSON.stringify(name));
console.log('deployment scripts: ok');
process.exit(0);
