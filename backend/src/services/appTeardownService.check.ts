import assert from 'assert';
import { folderRisk } from './appTeardownService';

const ok = (dir: string, others: string[] = []) => assert.strictEqual(folderRisk(dir, others), null, dir);
const refused = (dir: string | null, others: string[] = []) => assert.notStrictEqual(folderRisk(dir, others), null, String(dir));

// an app's own folder, inside an allowed root
ok('/home/deploy/shop');
ok('/var/www/shop.example.com/');
ok('/srv/apps/shop');
ok('/opt/shop');
ok('/root/shop');

// root and every system folder — including ones a denylist would forget
for (const dir of ['/', '//', '/.', '/root', '/home', '/var', '/var/www', '/var/www/html', '/srv', '/opt', '/etc', '/usr', '/tmp']) refused(dir);
for (const dir of ['/etc/caddy', '/var/lib/mysql', '/usr/lib', '/usr/local/bin', '/var/log/nginx', '/boot/efi', '/app', '/data/app']) refused(dir);
// a user's home itself, hidden folders, the panel's own org homes
for (const dir of ['/home/deploy', '/home/deploy/', '/home/deploy/.ssh', '/home/deploy/.pm2', '/root/.ssh', '/home/cb-acme/apps/x']) refused(dir);

// nothing to go on, or a path that could walk anywhere
refused(null);
refused('relative/dir');
refused('/home/deploy/shop/../..');
refused('/home/deploy/shop\n/');

// shared with another app: same, inside it, or around it
refused('/home/deploy/shop', ['/home/deploy/shop']);
refused('/home/deploy/shop', ['/home/deploy/shop/api']);
refused('/home/deploy/shop/api', ['/home/deploy/shop']);
// a sibling with a common prefix is not shared
ok('/home/deploy/shop', ['/home/deploy/shop-v2']);

console.log('appTeardown: ok');
