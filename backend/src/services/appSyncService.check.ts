/**
 * Self-check for the Caddyfile parser: npx ts-node src/services/appSyncService.check.ts
 */
import assert from 'assert';
import { parseCaddyfile } from './appSyncService';

const sample = `
# a comment
app.example.com {
    reverse_proxy localhost:3005
    encode gzip
}

shop.example.com, www.shop.example.com {
    root * /var/www/html/shop/public
    php_fastcgi unix//run/php/php8.2-fpm.sock
    file_server
}

static.example.com {
    root * /var/www/html/static
    file_server
    handle_errors {
        rewrite * /404.html
        file_server
    }
}
`;

const sites = parseCaddyfile(sample, '/etc/caddy/sites/example.caddy');

assert.strictEqual(sites.length, 3, 'three site blocks');

assert.deepStrictEqual(sites[0]?.domains, ['app.example.com']);
assert.strictEqual(sites[0]?.port, 3005);
assert.strictEqual(sites[0]?.php, false);

assert.deepStrictEqual(sites[1]?.domains, ['shop.example.com', 'www.shop.example.com']);
assert.strictEqual(sites[1]?.php, true);
assert.strictEqual(sites[1]?.rootPath, '/var/www/html/shop/public');

// the nested handle_errors block must not close the site early
assert.strictEqual(sites[2]?.domains[0], 'static.example.com');
assert.strictEqual(sites[2]?.php, false);
assert.strictEqual(sites[2]?.port, undefined);

console.log('appSyncService: parseCaddyfile OK');
