import 'dotenv/config';
import { allServers } from './lib/servers';
import { execRoot } from './lib/runner';
(async () => {
  const s = (await allServers()).find((x) => x.hostname === process.env.HOST)!;
  const script = `
systemctl set-property cb-depati-digital.slice MemoryMax=2G && systemctl show cb-depati-digital.slice -p MemoryMax -p MemoryCurrent
sleep 40; systemctl show cb-depati-digital-cmu6i3n0o1j3yo2ybqg14tiqj.service -p NRestarts -p ActiveState; curl -s -o /dev/null -w "%{http_code}
" http://127.0.0.1:20003/
`;
  const r = await execRoot(s, ['bash', '-c', script], { timeout: 90000 } as any);
  console.log(r.stdout, r.stderr);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
