/**
 * Self-check for the SSH key path fence: npx tsx src/routes/servers.check.ts
 *
 * This is the only thing standing between a form field and the control plane's
 * filesystem, so traversal and prefix tricks get a test each.
 */
import assert from 'assert';

process.env.CB_SSH_KEY_DIR = '/home/commitbase/.ssh';

async function main() {
  const { keyPathError } = await import('./servers');

  // inside the fence
  assert.strictEqual(keyPathError('/home/commitbase/.ssh/id_ed25519'), null);
  assert.strictEqual(keyPathError('/home/commitbase/.ssh/nodes/node2'), null);
  assert.strictEqual(keyPathError('/home/commitbase/.ssh'), null);

  // outside it
  assert.ok(keyPathError('/etc/shadow'));
  assert.ok(keyPathError('/home/commitbase/.ssh/../../../etc/shadow'));
  // a sibling directory that merely starts with the same string
  assert.ok(keyPathError('/home/commitbase/.sshsecrets/key'));
  assert.ok(keyPathError('relative/key'));

  console.log('servers: keyPathError OK');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
