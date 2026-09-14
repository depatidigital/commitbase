import { prisma } from './lib/prisma';
import { teardownPlan } from './services/appTeardownService';
(async () => {
  const app = await prisma.application.findUniqueOrThrow({ where: { domain: 'arusflow.pm2.local' } });
  const plan = await teardownPlan(app);
  console.log(JSON.stringify(plan.map((s) => ({ id: s.id, command: s.command, kept: s.kept, blocked: s.blocked, satisfied: s.satisfied })), null, 1));
  await prisma.$disconnect();
})();
