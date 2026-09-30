import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOG_SENDERS, parseLogSenders, queueBySender } from './stalwartService';

// the queue, by sender
const q = (id: string, returnPath: string, ip: string, rcpts: number, createdAt = '2026-09-30T00:00:00Z') => ({
  id, returnPath, receivedFromIp: ip, createdAt, recipients: Object.fromEntries(Array.from({ length: rcpts }, (_, i) => [`r${i}@x.com`, {}])),
});
const senders = queueBySender([q('1', 'spam@a.id', '1.1.1.1', 1), q('2', 'spam@a.id', '2.2.2.2', 1, '2026-09-29T00:00:00Z'), q('3', 'spam@a.id', '1.1.1.1', 2), q('4', '', '3.3.3.3', 1)]);
assert.deepStrictEqual(senders[0], { sender: 'spam@a.id', messages: 3, recipients: 4, ips: [{ ip: '1.1.1.1', messages: 2 }, { ip: '2.2.2.2', messages: 1 }], oldest: '2026-09-29T00:00:00Z' });
assert.strictEqual(senders[1]!.sender, '<>');

// the log, read the way the node reads it: lines as Stalwart writes them
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stalwart-'));
const line = (queueId: number, from: string, to: string) =>
  `2026-09-30T00:00:01Z INFO Connecting to remote server (delivery.connect) queueId = ${queueId}, queueName = "remote", from = "${from}", to = ["${to}"], size = 1111, total = 1, remoteIp = 17.57.152.5, remotePort = 25, elapsed = 209ms`;
fs.writeFileSync(path.join(dir, 'stalwart.2026-09-30'), [line(1, 'femi@a.id', 'x@icloud.com'), line(1, 'femi@a.id', 'x@icloud.com'), line(2, 'femi@a.id', 'y@outlook.com'), line(3, 'ok@a.id', 'z@b.com'), 'INFO no sender here'].join('\n') + '\n');
// a copy logrotate made of the same day counts too
fs.writeFileSync(path.join(dir, 'stalwart.2026-09-30.1'), line(4, 'femi@a.id', 'w@msn.com') + '\n');
const out = execFileSync('sh', ['-c', LOG_SENDERS, 'sh', dir.replace(/\\/g, '/'), '2026-09-30'], { encoding: 'utf8' });
assert.deepStrictEqual(parseLogSenders(out), [
  { sender: 'femi@a.id', messages: 3, recipients: 3, lines: 4 },
  { sender: 'ok@a.id', messages: 1, recipients: 1, lines: 1 },
]);
fs.rmSync(dir, { recursive: true });
console.log('stalwart: ok');
