/**
 * Build output reaches build.log while the build runs.
 * Run: npx tsx src/services/deployment.check.ts
 */
import assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { dotenvLine, streamToLog } from './deployment';
import { parseEnv } from 'util';

(async () => {
  const log = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'cb-log-')), 'build.log');
  await fs.writeFile(log, 'BUILD STARTED\n');

  await streamToLog(process.execPath, ['-e', 'console.log("out"); console.error("err")'], log, 10000);
  const text = await fs.readFile(log, 'utf-8');
  assert.ok(text.startsWith('BUILD STARTED\n'), 'appends, never truncates');
  assert.ok(text.includes('out') && text.includes('err'), 'stdout and stderr both land');

  await assert.rejects(streamToLog(process.execPath, ['-e', 'process.exit(3)'], log, 10000), /code 3/);
  await assert.rejects(streamToLog(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], log, 200), /killed/);

  console.log('deployment: streamToLog OK');
  process.exit(0);
})();

// .env lines read back verbatim by Node's own loader (process.loadEnvFile uses parseEnv)
for (const value of [
  'postgresql://u:p$w0rd@127.0.0.1:5432/db?sslmode=require',
  'has "double" quotes and a # hash',
  'spaces  and = signs',
  'line one\nline two',
  "it's quoted",
  `mixed 'single' and "double"`,
  '',
]) {
  const parsed = parseEnv(dotenvLine('K', value));
  assert.strictEqual(parsed.K, value, `round trip of ${JSON.stringify(value)}`);
}
console.log('deployment: dotenvLine OK');
