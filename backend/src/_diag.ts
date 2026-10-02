import 'dotenv/config';
import { allServers } from './lib/servers';
import { execRoot } from './lib/runner';
(async () => {
  const s = (await allServers()).find((x) => x.hostname === process.env.HOST)!;
  const script = process.env.SCRIPT!;
  const r = await execRoot(s, ['bash', '-c', script], { timeout: 280000 } as any);
  console.log(r.stdout, r.stderr);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
