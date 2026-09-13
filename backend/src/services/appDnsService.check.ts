import assert from 'assert';
import { isCloudflareIp } from './appDnsService';

// Cloudflare's edge: the orange cloud hides the origin behind these
assert.ok(isCloudflareIp('172.67.150.22'));
assert.ok(isCloudflareIp('104.21.29.250'));
assert.ok(isCloudflareIp('162.158.1.1'));
// an origin server, a public resolver, garbage
assert.ok(!isCloudflareIp('103.189.234.48'));
assert.ok(!isCloudflareIp('8.8.8.8'));
assert.ok(!isCloudflareIp('nope'));

console.log('appDnsService: ok');
