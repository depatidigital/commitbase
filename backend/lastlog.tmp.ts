import { prisma } from './src/lib/prisma';
(async () => {
  const logs = await prisma.log.findMany({
    where: { OR: [{ message: { contains: 'Caddy' } }, { message: { contains: 'nginx' } }] },
    orderBy: { createdAt: 'desc' }, take: 5, select: { createdAt: true, level: true, message: true },
  });
  for (const l of logs) console.log(l.createdAt.toISOString(), l.level, l.message);
  const s = await prisma.server.findMany({ select: { name: true, setupState: true, setupError: true, containerRuntime: true, lastError: true } });
  console.log(JSON.stringify(s, null, 1));
  await prisma.$disconnect();
})();
