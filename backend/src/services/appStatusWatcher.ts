import { prisma } from '../lib/prisma';
import * as systemd from './systemdService';

/**
 * Reconciles the stored application status with what systemd reports, so an
 * app that died outside the panel does not sit at RUNNING forever.
 *
 * ponytail: a 5-minute poll, not a systemd event subscription. Swap in
 * `systemctl --user monitor` / a D-Bus listener if the lag ever matters.
 */
const INTERVAL_MS = 300000;

let timer: NodeJS.Timeout | null = null;
let lastCheck: Date | null = null;

export async function checkAllApplications(): Promise<void> {
  const applications = await prisma.application.findMany({
    where: { status: 'RUNNING', runtime: null },
    include: { organization: { select: { slug: true } } },
  });

  for (const application of applications) {
    try {
      const status = await systemd.getStatus(application);
      if (status !== 'RUNNING') {
        await prisma.application.update({
          where: { id: application.id },
          data: { status },
        });
        console.log(`Application ${application.domain} is ${status}`);
      }
    } catch (error) {
      console.error(`Failed to check status for ${application.domain}:`, error);
    }
  }

  lastCheck = new Date();
}

export async function startWatching(): Promise<void> {
  if (timer) return;
  timer = setInterval(() => {
    checkAllApplications().catch(error => console.error('App status watcher error:', error));
  }, INTERVAL_MS);
  await checkAllApplications().catch(error => console.error('App status watcher error:', error));
}

export function stopWatching(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function getWatcherStatus(): { isWatching: boolean; lastCheck: Date | null } {
  return { isWatching: timer !== null, lastCheck };
}
