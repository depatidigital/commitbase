import { spawnSync } from 'node:child_process';
import { IMPORTED_DU, appDiskUsage } from './src/services/appDiskService';
import { prisma } from './src/lib/prisma';
(async () => {
  console.log('sh -n', spawnSync('sh', ['-n'], { input: IMPORTED_DU, encoding: 'utf8' }).status);
  for (const name of ['simadanialap-ws', 'pesona-kebaikan', 'ebmd-web', 'prakarsa']) {
    const app = await prisma.application.findFirst({ where: { processName: name, runtime: 'PM2' }, select: { id: true } });
    if (!app) { console.log(name, 'not an app here'); continue; }
    const disk = await appDiskUsage(app.id);
    console.log(name, { folderMB: ((disk?.sourcesBytes ?? 0) / 1e6).toFixed(1), pm2LogsMB: ((disk?.logsBytes ?? 0) / 1e6).toFixed(2) });
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e?.stderr || e?.message || e); process.exit(1); });
