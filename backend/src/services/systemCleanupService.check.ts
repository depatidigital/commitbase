import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupRotated, SYSTEM_TARGETS } from './systemCleanupService';

const out = [
  '100\t/var/log/syslog.1',
  '300\t/var/log/syslog.2.gz',
  '5000\t/var/log/btmp.1',
  '10\t/var/log/apt/history.log.3.gz',
  '7\t/var/log/dpkg.log-20260901.gz',
  '1\t/var/log/auth.log.old',
  '',
].join('\n');
assert.deepStrictEqual(groupRotated(out, 3), [
  { log: '/var/log/btmp', bytes: 5000, files: 1 },
  { log: '/var/log/syslog', bytes: 400, files: 2 },
  { log: '/var/log/apt/history.log', bytes: 10, files: 1 },
]);
assert.deepStrictEqual(groupRotated(out).map((g) => g.log).slice(3), ['/var/log/dpkg.log', '/var/log/auth.log']);
assert.deepStrictEqual(groupRotated(''), []);
console.log('systemCleanupService: ok');

// packageCaches: npm's cache goes whole; of pnpm's store only what nothing links
{
  const root = mkdtempSync(join(tmpdir(), 'root-')).replace(/\\/g, '/');
  const files = join(root, '.local/share/pnpm/store/v10/files/ab');
  mkdirSync(files, { recursive: true });
  mkdirSync(join(root, '.npm/_cacache'), { recursive: true });
  mkdirSync(join(root, 'app/node_modules'), { recursive: true });
  writeFileSync(join(files, 'used'), Buffer.alloc(1000));
  linkSync(join(files, 'used'), join(root, 'app/node_modules/used'));
  writeFileSync(join(files, 'unused'), Buffer.alloc(300));
  writeFileSync(join(files, 'x-index.json'), Buffer.alloc(7));
  writeFileSync(join(root, '.npm/_cacache/blob'), Buffer.alloc(50));
  const sh = (script: string) => execFileSync('sh', ['-c', script.split('/root/').join(`${root}/`)], { encoding: 'utf8' }).trim();
  const { measure, clean } = SYSTEM_TARGETS.packageCaches;
  assert.ok(Number(sh(measure)) >= 350 && Number(sh(measure)) < 5000, `measured ${sh(measure)}`);
  sh(clean);
  assert.ok(existsSync(join(files, 'used')), 'a linked store file stays');
  assert.ok(existsSync(join(files, 'x-index.json')), 'the index stays');
  assert.ok(!existsSync(join(files, 'unused')), 'an unlinked one goes');
  assert.ok(!existsSync(join(root, '.npm/_cacache')), "npm's cache goes");
  console.log('packageCaches: ok');
}
