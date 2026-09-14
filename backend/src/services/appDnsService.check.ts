import assert from 'assert';
import { answersLive, isCloudflareIp } from './appDnsService';

// an empty 404 at / is the web server with nothing to serve; an app's own 404 has a body
assert.ok(answersLive(200, '1234'));
assert.ok(answersLive(308, '0'));
assert.ok(answersLive(401, '0'));
assert.ok(answersLive(404, '139'));
assert.ok(answersLive(404, undefined)); // chunked: a body is coming
assert.ok(!answersLive(404, '0'));
assert.ok(!answersLive(502, '0'));
assert.ok(!answersLive(null));

// Cloudflare's edge: the orange cloud hides the origin behind these
assert.ok(isCloudflareIp('172.67.150.22'));
assert.ok(isCloudflareIp('104.21.29.250'));
assert.ok(isCloudflareIp('162.158.1.1'));
// an origin server, a public resolver, garbage
assert.ok(!isCloudflareIp('103.189.234.48'));
assert.ok(!isCloudflareIp('8.8.8.8'));
assert.ok(!isCloudflareIp('nope'));

console.log('appDnsService: ok');
