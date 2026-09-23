/**
 * Self-check for reading an existing nginx configuration:
 * npx tsx src/lib/nginxConfig.check.ts
 *
 * The fixtures are real sites-enabled files from a node being adopted, kept
 * verbatim — certbot's comments and companion blocks included, because those
 * are exactly the parts a parser gets wrong.
 */
import assert from 'assert';
import { loopbackPort, parseNginx, serverBlocks, siteOf, sitesOf, sizeToBytes } from './nginxConfig';

const PROXY_SITE = `
server {
    server_name jdih.empatlawangkab.go.id;

    location / {
        proxy_pass http://127.0.0.1:8082;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # VM boot can take a while — don't 504 during the booting page
        proxy_connect_timeout 10s;
        proxy_read_timeout    300s;
        proxy_send_timeout    300s;
        proxy_buffering       off;       # stream the auto-refresh booting page
    }

    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/jdih.empatlawangkab.go.id/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/jdih.empatlawangkab.go.id/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot

}
server {
    if ($host = jdih.empatlawangkab.go.id) {
        return 301 https://$host$request_uri;
    } # managed by Certbot


    server_name jdih.empatlawangkab.go.id;
    listen 80;
    return 404; # managed by Certbot


}
`;

const PHP_SITE = `
server {
    server_name webmail.empatlawangkab.go.id webmail.fundemy.id webmail.depatidigital.com webmail.arusflow.id;
    root /usr/share/roundcube;
    index index.php;

    client_max_body_size 50M;
    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php8.3-fpm.sock;

        fastcgi_read_timeout 300;
    }

    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/webmail.empatlawangkab.go.id/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/webmail.empatlawangkab.go.id/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot

}
server {
    if ($host = webmail.empatlawangkab.go.id) {
        return 301 https://$host$request_uri;
    } # managed by Certbot


    listen 80;
    server_name webmail.empatlawangkab.go.id;
    return 404; # managed by Certbot


}
`;

// the tokenizer: comments go, quoted arguments survive, nesting is kept
const parsed = parseNginx('server { server_name a.example; location / { proxy_pass http://127.0.0.1:1; } } # trailing');
assert.strictEqual(parsed.length, 1);
assert.strictEqual(parsed[0]!.name, 'server');
assert.strictEqual(serverBlocks(parsed).length, 1);
assert.deepStrictEqual(parseNginx('add_header X "a; b";')[0], { name: 'add_header', args: ['X', 'a; b'] });
// a server block nested under http { } is still found
assert.strictEqual(serverBlocks(parseNginx('http { server { server_name a; } }')).length, 1);

// a proxy site: the port, and the two directives that change how it behaves.
// Dropping them would 504 the booting page the config's own comment describes.
const proxy = sitesOf(PROXY_SITE);
assert.strictEqual(proxy.length, 1, 'the certbot :80 companion is not a site');
assert.strictEqual(proxy[0]!.kind, 'proxy');
assert.deepStrictEqual(proxy[0]!.hosts, ['jdih.empatlawangkab.go.id']);
assert.strictEqual(proxy[0]!.port, 8082);
assert.strictEqual(proxy[0]!.readTimeout, '300s');
assert.strictEqual(proxy[0]!.streaming, true);
assert.deepStrictEqual(proxy[0]!.warnings, []);
assert.deepStrictEqual(proxy[0]!.listens, [{ port: 443, ssl: true }]);

// PHP through FPM, and one block answering for four hostnames
const php = sitesOf(PHP_SITE);
assert.strictEqual(php.length, 1);
assert.strictEqual(php[0]!.kind, 'php');
assert.strictEqual(php[0]!.root, '/usr/share/roundcube');
assert.strictEqual(php[0]!.socket, '/run/php/php8.3-fpm.sock');
assert.strictEqual(php[0]!.hosts.length, 4);
assert.ok(php[0]!.hosts.includes('webmail.arusflow.id'));
assert.strictEqual(php[0]!.maxBodyBytes, 50 * 1024 * 1024);
// try_files reaching index.php is PHP's front controller, not an SPA fallback
assert.strictEqual(php[0]!.spa, undefined);

// a certbot companion on its own is a redirect, never an app that 404s
const redirectOnly = siteOf(serverBlocks(parseNginx(`
server { if ($host = a.example) { return 301 https://$host$request_uri; } listen 80; server_name a.example; return 404; }
`))[0]!);
assert.strictEqual(redirectOnly.kind, 'redirect');

// static files, with the single-page fallback
const spa = sitesOf('server { server_name s.example; root /var/www/s; location / { try_files $uri $uri/ /index.html; } }');
assert.strictEqual(spa[0]!.kind, 'static');
assert.strictEqual(spa[0]!.root, '/var/www/s');
assert.strictEqual(spa[0]!.spa, true);

// a proxy somewhere else is not this node's to serve — said, not guessed at
const remote = sitesOf('server { server_name r.example; location / { proxy_pass http://10.0.0.5:3000; } }');
assert.strictEqual(remote[0]!.kind, 'unknown');
assert.strictEqual(remote[0]!.warnings.length, 1);
assert.match(remote[0]!.warnings[0]!, /not a port on this machine/);

// upstreams by name are the same story
assert.strictEqual(loopbackPort('http://backend'), null);
assert.strictEqual(loopbackPort('http://127.0.0.1:8082'), 8082);
assert.strictEqual(loopbackPort('http://localhost:8082/'), 8082);
assert.strictEqual(loopbackPort('http://127.0.0.1:99999'), null);

assert.strictEqual(sizeToBytes('50M'), 52428800);
assert.strictEqual(sizeToBytes('512k'), 524288);
assert.strictEqual(sizeToBytes('20'), 20);
assert.strictEqual(sizeToBytes('big'), null);

// catch-all and wildcard names belong to no app in particular
const wildcard = sitesOf('server { server_name _; root /var/www/html; }');
assert.strictEqual(wildcard.length, 0);

console.log('nginxConfig: ok');
